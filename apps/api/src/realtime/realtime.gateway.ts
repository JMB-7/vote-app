import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import {
  REALTIME_AUTHORIZER,
  RealtimeAuthorizer,
  RealtimeClientToServerEvents,
  RealtimeCredentials,
  RealtimeIdentity,
  RealtimeInterServerEvents,
  RealtimeServerToClientEvents,
  RealtimeSocketData,
  roomFor,
} from './realtime.types.js'
import { isAllowedWebOrigin } from '../config/origins.js'

export type RealtimeServer = Server<
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
  RealtimeInterServerEvents,
  RealtimeSocketData
>

export type RealtimeSocket = Socket<
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
  RealtimeInterServerEvents,
  RealtimeSocketData
>

function readCredentials(auth: unknown): RealtimeCredentials | null {
  if (!auth || typeof auth !== 'object') return null
  const value = auth as Record<string, unknown>
  if (value.audience === 'public' && typeof value.assemblyCode === 'string' && value.assemblyCode.length > 0) {
    return { audience: 'public', assemblyCode: value.assemblyCode }
  }
  if (value.audience === 'participant' && typeof value.participantSessionToken === 'string' && value.participantSessionToken.length > 0) {
    return { audience: 'participant', participantSessionToken: value.participantSessionToken }
  }
  if (value.audience === 'moderator' && typeof value.assemblyId === 'string' && value.assemblyId.length > 0 && typeof value.moderatorCredential === 'string' && value.moderatorCredential.length > 0) {
    return { audience: 'moderator', assemblyId: value.assemblyId, moderatorCredential: value.moderatorCredential }
  }
  return null
}

function identityMatchesCredential(identity: RealtimeIdentity, credentials: RealtimeCredentials): boolean {
  if (identity.audience !== credentials.audience) return false
  return credentials.audience !== 'moderator' || identity.assemblyId === credentials.assemblyId
}

@WebSocketGateway({
  namespace: '/events',
  cors: { origin: (origin, callback) => callback(null, isAllowedWebOrigin(origin)), credentials: false },
})
@Injectable()
export class RealtimeGateway implements OnGatewayConnection<RealtimeSocket> {
  @WebSocketServer()
  private server!: RealtimeServer

  private readonly logger = new Logger(RealtimeGateway.name)

  constructor(@Inject(REALTIME_AUTHORIZER) private readonly authorizer: RealtimeAuthorizer) {}

  async handleConnection(client: RealtimeSocket): Promise<void> {
    const credentials = readCredentials(client.handshake.auth)
    if (!credentials) {
      client.disconnect(true)
      return
    }

    try {
      const identity = await this.authorizer.authenticate(credentials)
      if (!identityMatchesCredential(identity, credentials) || !isValidIdentity(identity)) {
        client.disconnect(true)
        return
      }

      // Room names and identifiers are derived only from validated server claims.
      client.data.identity = identity
      await client.join(roomFor(identity))
      if (identity.audience === 'participant') {
        await client.join(participantBroadcastRoom(identity.assemblyId))
      }
    } catch {
      // Do not log credentials, tokens, or auth-provider error bodies.
      this.logger.warn('Rejected unauthenticated realtime connection')
      client.disconnect(true)
    }
  }

  publisher(): RealtimePublisher {
    return new RealtimePublisher(this.server)
  }

  assemblyState(assemblyId: string, payload: Parameters<RealtimePublisher['assemblyState']>[1]): void { this.publisher().assemblyState(assemblyId, payload) }
  lobbyState(assemblyId: string, payload: Parameters<RealtimePublisher['lobbyState']>[1]): void { this.publisher().lobbyState(assemblyId, payload) }
  participantJoined(assemblyId: string, payload: Parameters<RealtimePublisher['participantJoined']>[1]): void { this.publisher().participantJoined(assemblyId, payload) }
  participantUpdated(assemblyId: string, payload: Parameters<RealtimePublisher['participantUpdated']>[1]): void { this.publisher().participantUpdated(assemblyId, payload) }
  participantRemoved(assemblyId: string, participantId: string): void { this.publisher().participantRemoved(assemblyId, participantId) }
  participantState(sessionId: string, payload: Parameters<RealtimePublisher['participantState']>[1]): void { this.publisher().participantState(sessionId, payload) }
  roundState(assemblyId: string, payload: Parameters<RealtimePublisher['roundState']>[1]): void { this.publisher().roundState(assemblyId, payload) }
  roundOpened(assemblyId: string, payload: Parameters<RealtimePublisher['roundOpened']>[1]): void { this.publisher().roundOpened(assemblyId, payload) }
  roundClosed(assemblyId: string, roundId: string): void { this.publisher().roundClosed(assemblyId, roundId) }
  participationCount(assemblyId: string, payload: Parameters<RealtimePublisher['participationCount']>[1]): void { this.publisher().participationCount(assemblyId, payload) }
  resultsPublished(assemblyId: string, payload: Parameters<RealtimePublisher['resultsPublished']>[1]): void { this.publisher().resultsPublished(assemblyId, payload) }
}

function isValidIdentity(identity: RealtimeIdentity): boolean {
  if (!identity.assemblyId) return false
  if (identity.audience === 'participant') return Boolean(identity.sessionId)
  if (identity.audience === 'moderator') return Boolean(identity.moderatorId)
  return true
}

function publicRoom(assemblyId: string): string {
  return `assembly:${assemblyId}:public`
}

function moderatorRoom(assemblyId: string): string {
  return `assembly:${assemblyId}:moderators`
}

function participantBroadcastRoom(assemblyId: string): string {
  return `assembly:${assemblyId}:participants`
}

/** Narrow, typed publishing surface for Fase 02 domain-event adapters. */
export class RealtimePublisher {
  constructor(private readonly server: RealtimeServer) {}

  assemblyState(assemblyId: string, payload: RealtimeServerToClientEvents['assembly.state'] extends (arg: infer P) => void ? P : never): void {
    this.server.to([publicRoom(assemblyId), moderatorRoom(assemblyId), participantBroadcastRoom(assemblyId)]).emit('assembly.state', {
      status: payload.status,
      ...(payload.completedAt ? { completedAt: payload.completedAt } : {}),
    })
  }

  lobbyState(assemblyId: string, payload: RealtimeServerToClientEvents['lobby.state'] extends (arg: infer P) => void ? P : never): void {
    this.server.to([publicRoom(assemblyId), moderatorRoom(assemblyId)]).emit('lobby.state', {
      status: payload.status,
      participantCount: payload.participantCount,
    })
  }

  participantJoined(assemblyId: string, payload: RealtimeServerToClientEvents['participant.joined'] extends (arg: infer P) => void ? P : never): void {
    this.server.to(moderatorRoom(assemblyId)).emit('participant.joined', {
      participantId: payload.participantId,
      firstName: payload.firstName,
      lastName: payload.lastName,
    })
  }

  participantUpdated(assemblyId: string, payload: RealtimeServerToClientEvents['participant.updated'] extends (arg: infer P) => void ? P : never): void {
    this.server.to(moderatorRoom(assemblyId)).emit('participant.updated', {
      participantId: payload.participantId,
      firstName: payload.firstName,
      lastName: payload.lastName,
    })
  }

  participantRemoved(assemblyId: string, participantId: string): void {
    this.server.to(moderatorRoom(assemblyId)).emit('participant.removed', { participantId })
    // Revoke the live socket immediately after the session is removed. Re-authentication
    // also rejects it, but without this step it could still receive assembly-wide events.
    this.server.in(`participant:${participantId}`).disconnectSockets(true)
  }

  participantState(sessionId: string, payload: RealtimeServerToClientEvents['participant.state'] extends (arg: infer P) => void ? P : never): void {
    const openRound = payload.openRound ? {
      roundId: payload.openRound.roundId,
      status: payload.openRound.status,
      title: payload.openRound.title,
      options: payload.openRound.options.map(({ optionId, label }) => ({ optionId, label })),
    } : null
    const results = payload.openRound?.status === 'published' && payload.results
      ? payload.results.map(({ optionId, label, count }) => ({ optionId, label, count }))
      : undefined
    this.server.to(`participant:${sessionId}`).emit('participant.state', {
      assemblyStatus: payload.assemblyStatus,
      ...(payload.assemblyCompletedAt !== undefined ? { assemblyCompletedAt: payload.assemblyCompletedAt } : {}),
      lobbyStatus: payload.lobbyStatus,
      openRound,
      participationStatus: payload.participationStatus,
      ...(results ? { results } : {}),
    })
  }

  roundState(assemblyId: string, payload: RealtimeServerToClientEvents['round.state'] extends (arg: infer P) => void ? P : never): void {
    this.server.to([publicRoom(assemblyId), moderatorRoom(assemblyId)]).emit('round.state', publicRoundPayload(payload))
  }

  roundOpened(assemblyId: string, payload: RealtimeServerToClientEvents['round.opened'] extends (arg: infer P) => void ? P : never): void {
    this.server.to(participantBroadcastRoom(assemblyId)).emit('round.opened', {
      ...publicRoundPayload(payload),
      options: payload.options.map(({ optionId, label }) => ({ optionId, label })),
    })
  }

  roundClosed(assemblyId: string, roundId: string): void {
    this.server.to(participantBroadcastRoom(assemblyId)).emit('round.closed', { roundId })
  }

  participationCount(assemblyId: string, payload: RealtimeServerToClientEvents['participation.count'] extends (arg: infer P) => void ? P : never): void {
    this.server.to([publicRoom(assemblyId), moderatorRoom(assemblyId)]).emit('participation.count', {
      roundId: payload.roundId,
      recorded: payload.recorded,
      eligible: payload.eligible,
    })
  }

  resultsPublished(assemblyId: string, payload: RealtimeServerToClientEvents['results.published'] extends (arg: infer P) => void ? P : never): void {
    const sanitized = {
      roundId: payload.roundId,
      options: payload.options.map(({ optionId, label, count }) => ({ optionId, label, count })),
    }
    this.server.to([publicRoom(assemblyId), participantBroadcastRoom(assemblyId)]).emit('results.published', sanitized)
    this.server.to(moderatorRoom(assemblyId)).emit('results.published', sanitized)
  }
}

function publicRoundPayload(payload: RealtimeServerToClientEvents['round.state'] extends (arg: infer P) => void ? P : never) {
  return { roundId: payload.roundId, status: payload.status, title: payload.title }
}
