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
  } finally {
    if (assemblyId) await prisma.assembly.deleteMany({ where: { id: assemblyId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})
