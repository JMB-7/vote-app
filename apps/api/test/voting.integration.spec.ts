import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ConflictException, UnprocessableEntityException } from '@nestjs/common'
import { hashCredential, newOpaqueCredential } from '../src/auth/credentials.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { VotingService } from '../src/voting/voting.service.js'
import type { RealtimeGateway } from '../src/realtime/realtime.gateway.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

test('database voting flow: unique concurrent cast, close gate, then explicit publish', {
  skip: !testDatabaseUrl ? 'Define TEST_DATABASE_URL pointing to a disposable PostgreSQL database' : false,
}, async () => {
  process.env.DATABASE_URL = testDatabaseUrl
  const prisma = new PrismaService()
  await prisma.$connect()
  const organizationId = randomUUID()
  const joinCode = newOpaqueCredential()
  const token = newOpaqueCredential()
  const noOp = () => undefined
  const realtimeEvents: Array<{ name: string; payload: unknown }> = []
  const realtime = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => {
    if (name === 'assemblyState') realtimeEvents.push({ name: String(name), payload: args[1] })
    return noOp()
  } }) as RealtimeGateway
  const service = new VotingService(prisma, realtime)
  let assemblyId: string | undefined

  try {
    const organization = await prisma.organization.create({ data: { id: organizationId, name: `test-${organizationId}`, type: 'union' } })
    const assembly = await prisma.assembly.create({
      data: {
        organizationId: organization.id,
        name: 'Integration test',
        status: 'in_progress',
        joinCodeHash: hashCredential(joinCode),
      },
    })
    assemblyId = assembly.id
    const participant = await prisma.participantSession.create({
      data: { assemblyId, firstName: 'Test', lastName: 'Participant', tokenHash: hashCredential(token) },
    })
    const round = await prisma.round.create({
      data: {
        assemblyId,
        title: 'Integration test ballot',
        countingRule: { kind: 'count_only' },
        status: 'open',
        openedAt: new Date(),
        options: { create: [{ label: 'Option A', order: 0 }, { label: 'Option B', order: 1 }] },
      },
      include: { options: true },
    })

    await assert.rejects(service.completeAssembly(assemblyId, true), (error: unknown) =>
      error instanceof ConflictException && error.message.includes('Cierra la papeleta abierta'),
    )

    const duplicateAttempts = await Promise.allSettled([
      service.castVote(participant.id, round.id, round.options[0].id),
      service.castVote(participant.id, round.id, round.options[1].id),
    ])
    assert.equal(duplicateAttempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
    const rejected = duplicateAttempts.find((attempt) => attempt.status === 'rejected')
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConflictException)
    assert.equal(await prisma.participation.count({ where: { roundId: round.id } }), 1)
    assert.equal(await prisma.anonymousVote.count({ where: { roundId: round.id } }), 1)

    const snapshot = await service.participantState(participant.id)
    assert.equal(snapshot.openRound?.roundId, round.id)
    assert.equal(snapshot.participationStatus, 'recorded')
    assert.equal('optionId' in (snapshot.openRound ?? {}), false)

    await service.closeRound(round.id)
    const closedSnapshot = await service.participantState(participant.id)
    assert.equal(closedSnapshot.openRound?.status, 'closed')
    assert.equal(closedSnapshot.participationStatus, 'recorded')
    await assert.rejects(service.castVote(participant.id, round.id, round.options[0].id), ConflictException)
    const hidden = await service.publicState(joinCode)
    assert.equal('results' in hidden, false)

    const published = await service.publishRound(round.id)
    assert.equal(published.status, 'published')
    assert.equal(published.results.reduce((sum, option) => sum + option.count, 0), 1)
    const publishedSnapshot = await service.participantState(participant.id)
    assert.equal(publishedSnapshot.openRound?.status, 'published')
    assert.equal(publishedSnapshot.results?.reduce((sum, option) => sum + option.count, 0), 1)
    const visible = await service.publicState(joinCode)
    assert.equal('results' in visible, true)
    assert.equal('officialResult' in visible, false, 'publishing vote counts must not declare a winner')

    const declared = await service.declareOfficialResult(round.id, { optionIds: [round.options[0].id], note: 'Decisión de la mesa' })
    assert.deepEqual(declared.elected, [{ optionId: round.options[0].id, label: 'Option A' }])
    assert.equal(declared.publishedAt, null)
    assert.equal('officialResult' in await service.publicState(joinCode), false, 'an unpublished declaration stays private')
    const moderatorView = await service.moderatorAssembly(assemblyId)
    assert.deepEqual(moderatorView.rounds[0]?.officialResult?.elected, declared.elected)
    assert.equal(moderatorView.rounds[0]?.officialResult?.declaredBy, 'shared_moderator_credential')
    assert.equal(await prisma.auditEvent.count({ where: { roundId: round.id, action: 'round.official_result.declared' } }), 1)

    await service.publishOfficialResult(round.id)
    const publiclyDeclared = await service.publicState(joinCode)
    assert.deepEqual(publiclyDeclared.officialResult?.elected, declared.elected)

    const corrected = await service.declareOfficialResult(round.id, { optionIds: [round.options[1].id], note: 'Corrección de acta' })
    assert.equal(corrected.publishedAt, null, 'a correction requires a fresh explicit publication')
    assert.equal('officialResult' in await service.publicState(joinCode), false)
    await service.publishOfficialResult(round.id)
    assert.deepEqual((await service.publicState(joinCode)).officialResult?.elected, [{ optionId: round.options[1].id, label: 'Option B' }])
    assert.equal(await prisma.auditEvent.count({ where: { roundId: round.id, action: 'round.official_result.corrected' } }), 1)
    assert.equal(await prisma.auditEvent.count({ where: { roundId: round.id, action: 'round.official_result.published' } }), 2)

    await assert.rejects(service.completeAssembly(assemblyId, false as true), (error: unknown) =>
      error instanceof UnprocessableEntityException,
    )
    const completed = await service.completeAssembly(assemblyId, true)
    const repeatedCompletion = await service.completeAssembly(assemblyId, true)
    assert.deepEqual(repeatedCompletion, completed)
    assert.equal(await prisma.auditEvent.count({ where: { assemblyId, action: 'assembly.completed' } }), 1)
    assert.equal(realtimeEvents.length, 1)
    assert.deepEqual(realtimeEvents[0]?.payload, { status: 'completed', completedAt: completed.completedAt })

    await assert.rejects(service.joinAssembly(joinCode, 'Late', 'Join'), ConflictException)
    await assert.rejects(service.createRound(assemblyId, {
      title: 'Late ballot', format: 'single_choice', options: [{ label: 'A' }, { label: 'B' }], countingRule: { kind: 'count_only' },
    }), ConflictException)
    await assert.rejects(service.castVote(participant.id, round.id, round.options[0].id), ConflictException)
    await assert.rejects(service.changeLobby(assemblyId, 'lobby_closed'), ConflictException)
    await assert.rejects(service.patchParticipant(participant.id, { firstName: 'Changed' }), ConflictException)

    const completedParticipantState = await service.participantState(participant.id)
    assert.equal(completedParticipantState.assemblyStatus, 'completed')
    assert.equal(completedParticipantState.assemblyCompletedAt, completed.completedAt)
    const completedPublicState = await service.publicState(joinCode)
    assert.equal(completedPublicState.assembly.status, 'completed')
    assert.equal(completedPublicState.assembly.completedAt, completed.completedAt)
    assert.deepEqual(completedPublicState.results, published.results)
    const completedModeratorState = await service.moderatorAssembly(assemblyId)
    assert.equal(completedModeratorState.status, 'completed')
    assert.equal(completedModeratorState.completedAt, completed.completedAt)

    const postCompletionCorrection = await service.declareOfficialResult(round.id, {
      optionIds: [round.options[0].id, round.options[1].id], note: 'La mesa confirma dos personas electas',
    })
    assert.equal(postCompletionCorrection.publishedAt, null)
    assert.equal('officialResult' in await service.publicState(joinCode), false)
    await service.publishOfficialResult(round.id)
    assert.deepEqual((await service.publicState(joinCode)).officialResult?.elected.map((item) => item.label), ['Option A', 'Option B'])
    assert.equal(await prisma.auditEvent.count({ where: { roundId: round.id, action: 'round.official_result.corrected' } }), 2)
  } finally {
    if (assemblyId) {
      await prisma.round.deleteMany({ where: { assemblyId } })
      await prisma.participantSession.deleteMany({ where: { assemblyId } })
      await prisma.assembly.deleteMany({ where: { id: assemblyId } })
    }
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})

test('database nomination flow keeps secret votes separate, resolves the last-seat tie, and publishes the official composition explicitly', {
  skip: !testDatabaseUrl ? 'Define TEST_DATABASE_URL pointing to a disposable PostgreSQL database' : false,
}, async () => {
  process.env.DATABASE_URL = testDatabaseUrl
  const prisma = new PrismaService()
  await prisma.$connect()
  const organizationId = randomUUID()
  const joinCode = newOpaqueCredential()
  const realtime = new Proxy({}, { get: () => () => undefined }) as RealtimeGateway
  const service = new VotingService(prisma, realtime)
  let assemblyId: string | undefined
  try {
    const organization = await prisma.organization.create({ data: { id: organizationId, name: `committee-test-${organizationId}`, type: 'union' } })
    const assembly = await prisma.assembly.create({ data: { organizationId: organization.id, name: 'Nomination integration', status: 'in_progress', joinCodeHash: hashCredential(joinCode) } })
    const activeAssemblyId = assembly.id
    assemblyId = activeAssemblyId
    const candidates = await Promise.all(Array.from({ length: 6 }, (_, index) => prisma.participantSession.create({ data: {
      assemblyId: activeAssemblyId, firstName: `Candidate${index}`, lastName: 'Delegate', tokenHash: hashCredential(newOpaqueCredential()),
      assemblyRole: 'delegate', committeeEligible: true,
    } })))
    const president = await prisma.participantSession.create({ data: { assemblyId: activeAssemblyId, firstName: 'President', lastName: 'Excluded', tokenHash: hashCredential(newOpaqueCredential()), assemblyRole: 'president', committeeEligible: true } })
    const proposalRound = await prisma.round.create({ data: {
      assemblyId: activeAssemblyId, title: 'Propuestas', format: 'multiple_choice', category: 'committee', committeeType: 'nomination',
      memberCount: 5, committeeStage: 'proposals', status: 'draft', countingRule: { kind: 'count_only' },
      committeeConfiguration: { proposalRule: 'eligible_delegate_only', supportRule: 'one_per_eligible_delegate', supportMinimum: 1 },
    } })
    await assert.rejects(service.submitCommitteeProposal(candidates[0]!.id, proposalRound.id, president.id), UnprocessableEntityException)
    const proposal = await service.submitCommitteeProposal(candidates[0]!.id, proposalRound.id, candidates[1]!.id)
    await prisma.round.update({ where: { id: proposalRound.id }, data: { committeeStage: 'support' } })
    await service.supportCommitteeProposal(candidates[2]!.id, proposalRound.id, proposal.id)
    await assert.rejects(service.supportCommitteeProposal(candidates[2]!.id, proposalRound.id, proposal.id), ConflictException)
    const supportState = await service.participantState(candidates[2]!.id)
    assert.equal(supportState.committeeProposals?.[0]?.supportedByMe, true)
    assert.equal(JSON.stringify(supportState).includes('supporterParticipantId'), false)
    const round = await prisma.round.create({ data: {
      assemblyId: activeAssemblyId, title: 'Comisión de Nombramiento', format: 'multiple_choice', category: 'committee', committeeType: 'nomination',
      memberCount: 5, electionSeats: 5, committeeStage: 'election', status: 'draft',
      decisionNote: 'Configuración validada por Secretaría',
      committeeConfiguration: { institutionallyValidated: true, validationReference: 'ACTA-TEST', eligibilityRule: 'delegados confirmados', votingMethod: 'voto secreto' },
      countingRule: { kind: 'count_only' },
      options: { create: candidates.map((candidate, order) => ({ label: `${candidate.firstName} ${candidate.lastName}`, order, candidateParticipantId: candidate.id })) },
    }, include: { options: true } })
    await service.openRound(round.id)
    for (let voter = 0; voter < 5; voter += 1) {
      const selections = round.options.slice(0, 4).map((option) => option.id)
      if (voter < 2) selections.push(round.options[4]!.id)
      else if (voter < 4) selections.push(round.options[5]!.id)
      await service.castVote(candidates[voter]!.id, round.id, selections)
    }
    assert.equal(await prisma.anonymousVote.count({ where: { roundId: round.id } }), 24)
    assert.equal('participantSessionId' in ((await prisma.anonymousVote.findFirst({ where: { roundId: round.id } })) ?? {}), false)
    const closed = await service.closeRound(round.id)
    assert.ok(closed.tieBreakRoundId)
    const rootAfterTie = await prisma.round.findUniqueOrThrow({ where: { id: round.id } })
    assert.equal(rootAfterTie.committeeStage, 'tie_break_required')
    const tieRoundId = closed.tieBreakRoundId!
    const tieRound = await prisma.round.findUniqueOrThrow({ where: { id: tieRoundId }, include: { options: true } })
    assert.equal(tieRound.options.length, 2)
    await service.openRound(tieRoundId)
    await service.castVote(candidates[4]!.id, tieRoundId, [tieRound.options[0]!.id])
    const tieClosed = await service.closeRound(tieRoundId)
    assert.equal('tieBreakRoundId' in tieClosed, false)
    assert.equal((await prisma.round.findUniqueOrThrow({ where: { id: round.id } })).committeeStage, 'composition_ready')
    const internal = await service.publicState(joinCode)
    assert.equal('results' in internal, false)
    await service.publishRound(round.id)
    const countsPublished = await service.publicState(joinCode)
    assert.equal('results' in countsPublished, true)
    assert.equal('officialResult' in countsPublished, false)
    const declared = await service.declareOfficialResult(round.id, { optionIds: round.options.slice(0, 5).map((option) => option.id), note: 'Composición aprobada por la mesa' })
    assert.equal(declared.publishedAt, null)
    assert.equal('officialResult' in await service.publicState(joinCode), false)
    await service.publishOfficialResult(round.id)
    assert.equal('officialResult' in await service.publicState(joinCode), true)
    const audit = await prisma.auditEvent.findMany({ where: { assemblyId, action: { startsWith: 'committee.election.' } } })
    assert.ok(audit.some((entry) => entry.action === 'committee.election.tie_break_required'))
    assert.ok(audit.some((entry) => entry.action === 'committee.election.composition_ready'))
    const history = await service.moderatorAssembly(assemblyId)
    assert.equal(history.rounds.find((item) => item.id === round.id)?.committeeComposition?.length, 5)
  } finally {
    if (assemblyId) {
      await prisma.round.deleteMany({ where: { assemblyId } })
      await prisma.participantSession.deleteMany({ where: { assemblyId } })
      await prisma.assembly.deleteMany({ where: { id: assemblyId } })
    }
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
