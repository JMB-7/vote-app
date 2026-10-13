import assert from 'node:assert/strict'
import test from 'node:test'
import { UnprocessableEntityException } from '@nestjs/common'
import { VotingService } from '../src/voting/voting.service.js'

const service = new VotingService({} as never, {} as never)
const base = {
  title: 'Comisión',
  format: 'single_choice' as const,
  options: [{ label: 'Delegado A' }, { label: 'Delegado B' }],
  countingRule: { kind: 'count_only' },
}

test('committee configuration requires an explicit type and validates only committee-specific sizes', async () => {
  await assert.rejects(service.createRound('assembly', { ...base, category: 'committee' }), UnprocessableEntityException)
  await assert.rejects(service.createRound('assembly', { ...base, category: 'committee', committeeType: 'nomination', memberCount: 4 }), UnprocessableEntityException)
  await assert.rejects(service.createRound('assembly', { ...base, category: 'committee', committeeType: 'nomination', memberCount: 3 }), UnprocessableEntityException)
  await assert.rejects(service.createRound('assembly', { ...base, category: 'committee', committeeType: 'finance', memberCount: 4 }), UnprocessableEntityException)
  await assert.rejects(service.createRound('assembly', { ...base, category: 'office', committeeType: 'finance' }), UnprocessableEntityException)
})

test('a declared committee composition must match its configured number of seats', async () => {
  const database = {
    $transaction: async (work: (tx: unknown) => unknown) => work({
      $queryRaw: async () => [{ id: 'round', assembly_id: 'assembly', status: 'closed', category: 'committee', member_count: 3 }],
    }),
  }
  const voting = new VotingService(database as never, {} as never)
  await assert.rejects(
    voting.declareOfficialResult('round', { optionIds: ['one', 'two'] }),
    UnprocessableEntityException,
  )
})

test('nomination simple majority uses only the explicitly configured denominator and records aggregates', async () => {
  const recorded: Record<string, unknown>[] = []
  const tx = {
    round: { findUnique: async () => ({ assemblyId: 'assembly', category: 'committee', committeeType: 'nomination', committeeStage: 'approval', committeeConfiguration: { approvalDenominator: 'valid_votes' } }) },
    committeeProposal: {
      findFirst: async () => ({ id: 'proposal' }),
      update: async ({ data }: { data: Record<string, unknown> }) => { recorded.push(data); return { id: 'proposal', ...data } },
    },
    participantSession: { count: async () => 9 },
    auditEvent: { create: async ({ data }: { data: { metadata: Record<string, unknown> } }) => { recorded.push(data.metadata); return data } },
  }
  const voting = new VotingService({ $transaction: async (work: (value: unknown) => unknown) => work(tx) } as never, {} as never)
  await voting.recordCommitteeApproval('round', 'proposal', { yesVotes: 3, noVotes: 2 })
  assert.equal(recorded[0]?.status, 'approved', 'three of five valid votes is a simple majority')
  assert.equal(recorded[0]?.approvalYes, 3)
  assert.equal(recorded[0]?.approvalNo, 2)
  assert.equal('voterId' in recorded[0]!, false, 'only aggregate counts are retained')
  assert.equal(recorded[1]?.basis, 'valid_votes')
})

test('valid-votes approval rejects aggregate votes above the eligible delegate roster', async () => {
  let updated = false
  const tx = {
    round: { findUnique: async () => ({ assemblyId: 'assembly', category: 'committee', committeeType: 'nomination', committeeStage: 'approval', committeeConfiguration: { approvalDenominator: 'valid_votes' } }) },
    committeeProposal: {
      findFirst: async () => ({ id: 'proposal' }),
      update: async () => { updated = true; return { id: 'proposal' } },
    },
    participantSession: { count: async () => 4 },
  }
  const voting = new VotingService({ $transaction: async (work: (value: unknown) => unknown) => work(tx) } as never, {} as never)
  await assert.rejects(voting.recordCommitteeApproval('round', 'proposal', { yesVotes: 3, noVotes: 2 }), /superan el número de delegados elegibles/)
  assert.equal(updated, false, 'impossible aggregate must not decide the proposal')
})

test('nomination configuration remains blocked when support or majority decisions are missing', async () => {
  const createdRound = { id: 'round', title: 'Comisión', format: 'multiple_choice', category: 'committee', committeeType: 'nomination', memberCount: 5, decisionNote: 'validada', committeeStage: 'configuration_required', committeeConfiguration: {}, countingRule: { kind: 'count_only' }, status: 'draft', options: [] }
  const tx = {
    $queryRaw: async () => [{ id: 'assembly', status: 'in_progress' }],
    participantSession: { count: async () => 0 },
    round: { create: async () => createdRound },
    auditEvent: { create: async () => ({}) },
  }
  const voting = new VotingService({ $transaction: async (work: (value: unknown) => unknown) => work(tx), round: { findUniqueOrThrow: async () => createdRound } } as never, {} as never)
  const result = await voting.createRound('assembly', {
    ...base, options: [], category: 'committee', committeeType: 'nomination', memberCount: 5,
    decisionNote: 'validada',
    committeeConfiguration: {
      institutionallyValidated: true, validationReference: 'ACTA-1', eligibilityRule: 'delegados elegibles',
      votingMethod: 'secreta', proposalRule: 'eligible_delegate_only',
    },
  })
  assert.equal(result.committeeStage, 'configuration_required')
  assert.deepEqual(result.options, [], 'no ballot is created while institutional rules are unresolved')
})

test('cannot begin nomination proposals when the support minimum exceeds eligible delegates', async () => {
  const createdRound = { id: 'round', title: 'Comisión', format: 'multiple_choice', category: 'committee', committeeType: 'nomination', memberCount: 5, decisionNote: 'validada', committeeStage: 'configuration_required', committeeConfiguration: {}, countingRule: { kind: 'count_only' }, status: 'draft', options: [] }
  const tx = {
    $queryRaw: async () => [{ id: 'assembly', status: 'lobby_closed' }],
    participantSession: { count: async ({ where }: { where: { assemblyRole?: string } }) => where.assemblyRole === 'delegate' ? 5 : 1 },
    round: { create: async ({ data }: { data: { committeeStage: string } }) => { createdRound.committeeStage = data.committeeStage as typeof createdRound.committeeStage; return createdRound } },
    auditEvent: { create: async () => ({}) },
  }
  const voting = new VotingService({ $transaction: async (work: (value: unknown) => unknown) => work(tx), round: { findUniqueOrThrow: async () => createdRound } } as never, {} as never)
  const result = await voting.createRound('assembly', {
    ...base, options: [], category: 'committee', committeeType: 'nomination', memberCount: 5, decisionNote: 'validada',
    committeeConfiguration: { institutionallyValidated: true, validationReference: 'ACTA-1', eligibilityRule: 'delegados elegibles', votingMethod: 'secreta', proposalRule: 'eligible_delegate_only', supportRule: 'one_per_eligible_delegate', supportMinimum: 6, approvalDenominator: 'eligible_delegates' },
  })
  assert.equal(result.committeeStage, 'configuration_required')
})

test('closing nomination supports rechecks the active eligible roster before changing proposal status', async () => {
  let proposalsRead = false
  const tx = {
    $queryRaw: async () => [{ id: 'round', assembly_id: 'assembly', status: 'draft', committee_stage: 'support', committee_type: 'nomination', member_count: 5, committee_configuration: { supportMinimum: 4 } }],
    participantSession: { count: async () => 3 },
    committeeProposal: { findMany: async () => { proposalsRead = true; return [{ id: 'proposal', _count: { supporters: 4 } }] }, update: async () => assert.fail('must not mutate proposal status') },
    round: { update: async () => assert.fail('must not advance the stage') },
  }
  const voting = new VotingService({ $transaction: async (work: (value: unknown) => unknown) => work(tx) } as never, {} as never)
  await assert.rejects(voting.advanceCommitteeStage('round', 'approval'), /mínimo configurado \(4\) supera los 3 delegados elegibles activos/)
  assert.equal(proposalsRead, false, 'reject before reading or mutating support results')
})
