/** Socket.IO wire contract. These types intentionally exclude vote selections. */
export type RealtimeCredentials =
  | { audience: 'public'; assemblyCode: string }
  | { audience: 'participant'; participantSessionToken: string }
  | { audience: 'moderator'; assemblyId: string; moderatorCredential: string }

export type RealtimeIdentity =
  | { audience: 'public'; assemblyId: string }
  | { audience: 'participant'; assemblyId: string; sessionId: string }
  | { audience: 'moderator'; assemblyId: string; moderatorId: string }

export interface RealtimeAuthorizer {
  /** Validates credentials and resolves every id used for room membership server-side. */
  authenticate(credentials: RealtimeCredentials): Promise<RealtimeIdentity>
}

export const REALTIME_AUTHORIZER = Symbol('REALTIME_AUTHORIZER')

export type LobbyStatus = 'open' | 'closed'
export type AssemblyStatus = 'preparing' | 'lobby_open' | 'lobby_closed' | 'in_progress' | 'completed'
export type RoundStatus = 'draft' | 'open' | 'closed' | 'published'

export interface LobbyStateEvent {
  status: LobbyStatus
  participantCount: number
}

export interface AssemblyStateEvent {
  status: AssemblyStatus
  completedAt?: string
}

export interface RoundStateEvent {
  roundId: string
  status: RoundStatus
  title: string
}

export interface ParticipationCountEvent {
  roundId: string
  recorded: number
  eligible: number
}

export interface ParticipantSummaryEvent {
  participantId: string
  firstName: string
  lastName: string
}

export interface ParticipantStateEvent {
  assemblyStatus: AssemblyStatus
  assemblyCompletedAt?: string | null
  lobbyStatus: LobbyStatus
  openRound: (RoundStateEvent & { options: Array<{ optionId: string; label: string }> }) | null
  participationStatus: 'pending' | 'recorded'
  results?: PublishedResultOption[]
}

export interface PublishedResultOption {
  optionId: string
  label: string
  count: number
}

export interface PublishedResultsEvent {
  roundId: string
  options: PublishedResultOption[]
}

export interface RealtimeServerToClientEvents {
  'assembly.state': (payload: AssemblyStateEvent) => void
  'lobby.state': (payload: LobbyStateEvent) => void
  'participant.joined': (payload: ParticipantSummaryEvent) => void
  'participant.updated': (payload: ParticipantSummaryEvent) => void
  'participant.removed': (payload: { participantId: string }) => void
  'participant.state': (payload: ParticipantStateEvent) => void
  'round.state': (payload: RoundStateEvent) => void
  'round.opened': (payload: RoundStateEvent & { options: Array<{ optionId: string; label: string }> }) => void
  'round.closed': (payload: { roundId: string }) => void
  'participation.count': (payload: ParticipationCountEvent) => void
  'results.published': (payload: PublishedResultsEvent) => void
}

export interface RealtimeClientToServerEvents {
  // No client event grants subscriptions or changes business state. Commands use HTTP.
}

export interface RealtimeInterServerEvents {}

export interface RealtimeSocketData {
  identity?: RealtimeIdentity
}

export function roomFor(identity: RealtimeIdentity): string {
  switch (identity.audience) {
    case 'public':
      return `assembly:${identity.assemblyId}:public`
    case 'moderator':
      return `assembly:${identity.assemblyId}:moderators`
    case 'participant':
      return `participant:${identity.sessionId}`
  }
}
