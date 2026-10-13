import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RealtimeGateway } from '../../src/realtime/realtime.gateway.js'
import type { RealtimeAuthorizer } from '../../src/realtime/realtime.types.js'

function socket(auth: unknown) {
  const rooms: string[] = []
  let disconnected = false
  return {
    handshake: { auth },
    data: {} as Record<string, unknown>,
    async join(room: string) { rooms.push(room) },
    disconnect() { disconnected = true },
    get rooms() { return rooms },
    get disconnected() { return disconnected },
  }
}

test('rejects socket without valid audience credentials', async () => {
  const authorizer: RealtimeAuthorizer = { async authenticate() { throw new Error('not called') } }
  const gateway = new RealtimeGateway(authorizer)
  const client = socket({ room: 'assembly:secret:moderators' })

  await gateway.handleConnection(client as never)

  assert.equal(client.disconnected, true)
  assert.deepEqual(client.rooms, [])
})

test('derives participant rooms from validated server identity', async () => {
  const authorizer: RealtimeAuthorizer = {
    async authenticate() { return { audience: 'participant', assemblyId: 'assembly-7', sessionId: 'session-3' } },
  }
  const gateway = new RealtimeGateway(authorizer)
  const client = socket({ audience: 'participant', participantSessionToken: 'opaque-token', room: 'assembly:other:moderators' })

  await gateway.handleConnection(client as never)

  assert.deepEqual(client.rooms.sort(), ['assembly:assembly-7:participants', 'participant:session-3'])
  assert.equal(client.disconnected, false)
})

test('rejects a credential whose validated identity has a different audience', async () => {
  const authorizer: RealtimeAuthorizer = {
    async authenticate() { return { audience: 'moderator', assemblyId: 'assembly-7', moderatorId: 'mod-1' } },
  }
  const gateway = new RealtimeGateway(authorizer)
  const client = socket({ audience: 'participant', participantSessionToken: 'opaque-token' })

  await gateway.handleConnection(client as never)

  assert.equal(client.disconnected, true)
  assert.deepEqual(client.rooms, [])
})

test('rejects moderator authentication resolved for a different assembly', async () => {
  const authorizer: RealtimeAuthorizer = {
    async authenticate() { return { audience: 'moderator', assemblyId: 'assembly-other', moderatorId: 'mod-1' } },
  }
  const gateway = new RealtimeGateway(authorizer)
  const client = socket({ audience: 'moderator', assemblyId: 'assembly-7', moderatorCredential: 'opaque-secret' })

  await gateway.handleConnection(client as never)

  assert.equal(client.disconnected, true)
  assert.deepEqual(client.rooms, [])
})

test('only moderator room receives participant names', () => {
  const emissions: Array<{ rooms: unknown; event: string; payload: unknown }> = []
  const server = {
    to(rooms: unknown) {
      return { emit(event: string, payload: unknown) { emissions.push({ rooms, event, payload }) } }
    },
  }
  const gateway = new RealtimeGateway({ async authenticate() { throw new Error() } })
  Object.assign(gateway, { server })

  gateway.publisher().participantJoined('assembly-7', {
    participantId: 'p-1', firstName: 'Ana', lastName: 'Paz',
    optionId: 'choice-secret', participantSessionToken: 'should-never-leak',
  } as never)

  assert.deepEqual(emissions, [{
    rooms: 'assembly:assembly-7:moderators',
    event: 'participant.joined',
    payload: { participantId: 'p-1', firstName: 'Ana', lastName: 'Paz' },
  }])
})

test('removing a participant closes their authenticated sockets', () => {
  const disconnectedRooms: string[] = []
  const server = {
    to() { return { emit() {} } },
    in(room: string) { return { disconnectSockets() { disconnectedRooms.push(room) } } },
  }
  const gateway = new RealtimeGateway({ async authenticate() { throw new Error() } })
  Object.assign(gateway, { server })

  gateway.participantRemoved('assembly-7', 'session-3')

  assert.deepEqual(disconnectedRooms, ['participant:session-3'])
})

test('assembly completion reaches public, moderator, and participant viewers with timestamp', () => {
  const emissions: Array<{ rooms: unknown; event: string; payload: unknown }> = []
  const server = {
    to(rooms: unknown) {
      return { emit(event: string, payload: unknown) { emissions.push({ rooms, event, payload }) } }
    },
  }
  const gateway = new RealtimeGateway({ async authenticate() { throw new Error() } })
  Object.assign(gateway, { server })

  gateway.assemblyState('assembly-7', { status: 'completed', completedAt: '2026-10-02T18:00:00.000Z' })

  assert.deepEqual(emissions, [{
    rooms: ['assembly:assembly-7:public', 'assembly:assembly-7:moderators', 'assembly:assembly-7:participants'],
    event: 'assembly.state',
    payload: { status: 'completed', completedAt: '2026-10-02T18:00:00.000Z' },
  }])
})

test('participant snapshot includes aggregates only after publication', () => {
  const emissions: Array<{ event: string; payload: unknown }> = []
  const server = {
    to() {
      return { emit(event: string, payload: unknown) { emissions.push({ event, payload }) } }
    },
  }
  const gateway = new RealtimeGateway({ async authenticate() { throw new Error() } })
  Object.assign(gateway, { server })

  gateway.participantState('session-3', {
    assemblyStatus: 'in_progress',
    lobbyStatus: 'closed',
    openRound: {
      roundId: 'round-1', status: 'closed', title: 'Presidencia',
      options: [{ optionId: 'option-1', label: 'Opción A' }],
      voterId: 'session-3', selectedOptionId: 'must-not-leak',
    },
    participationStatus: 'recorded',
    results: [{ optionId: 'option-1', label: 'Opción A', count: 1 }],
    sessionToken: 'must-not-leak',
  } as never)

  gateway.participantState('session-3', {
    assemblyStatus: 'in_progress',
    lobbyStatus: 'closed',
    openRound: {
      roundId: 'round-1', status: 'published', title: 'Presidencia',
      options: [{ optionId: 'option-1', label: 'Opción A' }],
      voterId: 'session-3', selectedOptionId: 'must-not-leak',
    },
    participationStatus: 'recorded',
    results: [{ optionId: 'option-1', label: 'Opción A', count: 1, voterIds: ['must-not-leak'] }],
    sessionToken: 'must-not-leak',
  } as never)

  assert.deepEqual(emissions, [{
    event: 'participant.state',
    payload: {
      assemblyStatus: 'in_progress',
      lobbyStatus: 'closed',
      openRound: { roundId: 'round-1', status: 'closed', title: 'Presidencia', options: [{ optionId: 'option-1', label: 'Opción A' }] },
      participationStatus: 'recorded',
    },
  }, {
    event: 'participant.state',
    payload: {
      assemblyStatus: 'in_progress',
      lobbyStatus: 'closed',
      openRound: { roundId: 'round-1', status: 'published', title: 'Presidencia', options: [{ optionId: 'option-1', label: 'Opción A' }] },
      participationStatus: 'recorded',
      results: [{ optionId: 'option-1', label: 'Opción A', count: 1 }],
    },
  }])
})
