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
