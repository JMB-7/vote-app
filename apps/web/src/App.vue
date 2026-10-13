<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { io, type Socket } from 'socket.io-client'

type PublicState = {
  assembly?: { id?: string; name?: string; status?: string; completedAt?: string | null; lobbyStatus?: string }
  assemblyCompletedAt?: string | null
  status?: string
  lobbyStatus?: string
  participants?: Array<{ id?: string; firstName: string; lastName: string; assemblyRole?: string | null; committeeEligible?: boolean }>
  participantCount?: number
  recordedCount?: number
  eligibleCount?: number
  participationStatus?: 'pending' | 'recorded'
  currentRound?: { id: string; title: string; status: string; format?: string; category?: 'office' | 'committee'; committeeType?: string | null; committeeStage?: string | null; memberCount?: number | null; options?: Array<{ id: string; label: string }>; participationCount?: number }
  committeeCandidates?: Array<{ id: string; firstName: string; lastName: string }>
  committeeProposals?: Array<{ id: string; candidateName: string; supportCount: number; supportedByMe?: boolean }>
  results?: Array<{ label: string; count: number }>
  officialResult?: { elected: Array<{ optionId: string; label: string }>; note: string | null; declaredAt: string }
  rounds?: Array<{
    id: string; title: string; status: string; format?: string; category?: 'office' | 'committee'; committeeType?: string | null; memberCount?: number | null; decisionNote?: string | null; committeeStage?: string | null; committeeConfiguration?: Record<string, any> | null; committeeRootRoundId?: string | null; committeeProposals?: Array<{ id: string; candidateParticipantId: string; candidateName: string; status: string; supportCount: number; approvalYes: number | null; approvalNo: number | null }>; committeeComposition?: Array<{ participantId: string; name: string; order: number }>; options: Array<{ id: string; label: string; candidateParticipantId?: string | null }>
    results?: Array<{ optionId: string; label: string; count: number }>
    officialResult?: { elected: Array<{ optionId: string; label: string }>; note: string | null; declaredBy: string; declaredAt: string; publishedAt: string | null } | null
  }>
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1'
const origin = window.location.origin
const route = ref(window.location.pathname)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const moderationConfirmation = ref<{ title: string; consequence: string; label: string; path: string; method: string; body?: unknown } | null>(null)
const state = ref<PublicState | null>(null)
const urlParams = new URLSearchParams(window.location.search)
const incomingJoinCode = urlParams.get('join') || urlParams.get('code') || ''
const code = ref(incomingJoinCode || localStorage.getItem('assemblyJoinCode') || '')
const firstName = ref('')
const lastName = ref('')
const sessionToken = ref(localStorage.getItem('participantSessionToken') || '')
const sessionAssemblyId = ref(localStorage.getItem('participantAssemblyId') || '')
const pendingJoinCode = ref('')
const moderatorToken = ref(sessionStorage.getItem('moderatorToken') || '')
const moderatorAuthState = ref<'unauthenticated' | 'validating' | 'authenticated' | 'validation_error'>(moderatorToken.value ? 'validating' : 'unauthenticated')
const moderatorCredential = ref('')
const assemblyId = ref(sessionStorage.getItem('assemblyId') || '')
const assemblyName = ref('Asamblea de Delegados')
const roundTitle = ref('')
const optionsText = ref('')
const roundCategory = ref<'office' | 'committee'>('office')
const committeeType = ref('nomination')
const committeeMemberCount = ref<number | null>(null)
const committeeDecisionNote = ref('')
const committeeInstitutionallyValidated = ref(false)
const committeeDecisionReference = ref('')
const committeeEligibilityRule = ref('')
const committeeVotingMethod = ref('')
const committeeProposalRule = ref('')
const committeeSupportRule = ref('')
const committeeSupportMinimum = ref<number | null>(null)
const committeeApprovalDenominator = ref('')
const committeeCandidateSelections = ref<string[]>([])
const committeeApprovalCounts = ref<Record<string, { yesVotes: number; noVotes: number }>>({})
const participantCandidateSelection = ref('')
const selectedOptions = ref<string[]>([])
const committeeEditingRoundId = ref('')
const showNextBallotForm = ref(false)
const reviewingVote = ref(false)
const voteSubmitting = ref(false)
const reviewHeading = ref<HTMLElement | null>(null)
const qrImage = ref('')
const officialSelections = ref<Record<string, string[]>>({})
const officialNotes = ref<Record<string, string>>({})
watch(() => state.value?.rounds, (rounds) => {
  for (const item of rounds || []) {
    if (!Array.isArray(officialSelections.value[item.id])) {
      officialSelections.value[item.id] = item.officialResult?.elected.map((person) => person.optionId) || []
      officialNotes.value[item.id] = item.officialResult?.note || ''
    }
  }
}, { immediate: true })
const realtimeActive = ref(false)
const realtimeConnected = ref(false)
const projectorFullscreen = ref(false)
let refreshTimer: number | undefined
let realtimeSocket: Socket | null = null

const role = computed(() => route.value.startsWith('/moderator') ? 'moderator' : route.value.startsWith('/projector') ? 'projector' : 'participant')
const assemblyStatus = computed(() => state.value?.assembly?.status || state.value?.status || 'preparing')
const lobbyStatus = computed(() => state.value?.assembly?.lobbyStatus || (state.value?.lobbyStatus === 'open' || assemblyStatus.value === 'lobby_open' ? 'lobby_open' : 'lobby_closed'))
const round = computed(() => state.value?.currentRound)
const assemblyCompletedAt = computed(() => state.value?.assembly?.completedAt || state.value?.assemblyCompletedAt || null)
const totalParticipants = computed(() => state.value?.participantCount ?? state.value?.participants?.length ?? 0)
const eligibleVotes = computed(() => state.value?.eligibleCount ?? state.value?.participantCount ?? 0)
const completionTime = computed(() => assemblyCompletedAt.value
  ? new Intl.DateTimeFormat('es-HN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(assemblyCompletedAt.value))
  : '')
const reviewedOptions = computed(() => round.value?.options?.filter((option) => selectedOptions.value.includes(option.id)) || [])
const eligibleCommitteeCandidates = computed(() => (state.value?.participants || []).filter((person) => person.assemblyRole === 'delegate' && person.committeeEligible))
const moderatorWorkflow = ['Revisar ingreso', 'Cerrar ingreso', 'Preparar papeleta', 'Abrir votación', 'Cerrar votación', 'Publicar resultados']
const moderatorWorkflowStep = computed(() => {
  if (assemblyStatus.value === 'completed') return moderatorWorkflow.length
  if (round.value?.status === 'open') return 4
  if (round.value?.status === 'closed') return 5
  if (round.value?.status === 'published') return 6
  if (round.value?.status === 'draft') return 3
  return lobbyStatus.value === 'lobby_open' ? 0 : 2
})
const moderatorSessionSummary = computed(() => {
  if (!assemblyId.value) return 'El estado de la sesión y las votaciones proviene del servidor.'
  const status = round.value?.status === 'published' ? 'Resultados publicados'
    : round.value?.status === 'closed' ? 'Votación cerrada'
      : round.value?.status === 'open' ? 'Votación abierta'
        : lobbyStatus.value === 'lobby_open' ? 'Ingreso abierto' : 'Ingreso cerrado'
  return `Sesión: ${state.value?.assembly?.name || 'Asamblea'} · ${status}`
})
const projectorProgressPercent = computed(() => {
  const eligible = state.value?.eligibleCount ?? 0
  const recorded = state.value?.recordedCount ?? 0
  return eligible > 0 ? Math.min(100, Math.round((recorded / eligible) * 100)) : 0
})

watch(reviewingVote, (reviewing) => {
  if (reviewing) void nextTick(() => reviewHeading.value?.focus())
})

function go(path: string) {
  const enteringModerator = path.startsWith('/moderator')
  if (enteringModerator) {
    moderatorAuthState.value = moderatorToken.value ? 'validating' : 'unauthenticated'
    state.value = null
  } else if (role.value === 'moderator') {
    state.value = null
  }
  history.pushState({}, '', path)
  route.value = path
  error.value = ''
  notice.value = ''
  void refresh()
}

function openProjectorWindow() {
  if (!code.value) {
    error.value = 'Primero crea una Asamblea para abrir su proyección.'
    return
  }
  const projectorUrl = new URL('/projector', window.location.origin)
  projectorUrl.searchParams.set('code', code.value)
  const projectorWindow = window.open(projectorUrl, 'asdmr-projector', 'popup,width=1600,height=900')
  if (!projectorWindow) {
    error.value = 'El navegador bloqueó la ventana. Permite las ventanas emergentes para abrir la proyección.'
    return
  }
  projectorWindow.opener = null
  projectorWindow.focus()
  error.value = ''
  notice.value = 'Proyección abierta en otra ventana. Muévela a la pantalla del televisor y actívala en pantalla completa.'
}

async function toggleProjectorFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.querySelector('.projector-page')?.requestFullscreen()
    projectorFullscreen.value = Boolean(document.fullscreenElement)
  } catch {
    error.value = 'No se pudo activar pantalla completa. Usa la opción de pantalla completa del navegador.'
  }
}

function syncProjectorFullscreen() {
  projectorFullscreen.value = Boolean(document.fullscreenElement)
}

async function request<T>(path: string, init: RequestInit = {}, token = ''): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API}${path}`, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiRequestError(body.message || 'No se pudo completar la solicitud. Intenta de nuevo.', response.status)
  return body as T
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

function isUnauthorized(e: unknown) {
  return e instanceof ApiRequestError && e.status === 401
}

function handleParticipantUnauthorized(e: unknown, token: string) {
  if (!isUnauthorized(e) || role.value !== 'participant' || !token || token !== sessionToken.value) return false
  clearParticipantSession()
  error.value = 'La sesión de delegado ya no está activa. Vuelve a ingresar mientras el ingreso a la asamblea esté abierto.'
  notice.value = ''
  return true
}

function clearParticipantSession() {
  sessionToken.value = ''
  sessionAssemblyId.value = ''
  pendingJoinCode.value = ''
  state.value = null
  selectedOptions.value = []
  reviewingVote.value = false
  voteSubmitting.value = false
  firstName.value = ''
  lastName.value = ''
  localStorage.removeItem('participantSessionToken')
  localStorage.removeItem('participantAssemblyId')
}

function normalizeState(value: Record<string, any>): PublicState {
  const rawRound = value.currentRound || value.openRound || value.round || value.rounds?.at(-1) || null
  const options = rawRound?.options?.map((option: any) => ({ id: option.id || option.optionId, label: option.label }))
  const currentRound = rawRound ? {
    id: rawRound.id || rawRound.roundId,
    title: rawRound.title,
    status: rawRound.status,
    format: rawRound.format,
    category: rawRound.category || (rawRound.committeeType ? 'committee' : 'office'),
    committeeType: rawRound.committeeType,
    committeeStage: rawRound.committeeStage || rawRound.stage || rawRound.committee?.stage,
    memberCount: rawRound.memberCount,
    ...(options ? { options } : {}),
    ...(rawRound.participationCount !== undefined ? { participationCount: rawRound.participationCount } : {}),
  } : undefined
  const assembly = value.assembly || (value.assemblyStatus
    ? { status: value.assemblyStatus }
    : value.id ? { id: value.id, name: value.name, status: value.status, completedAt: value.completedAt ?? null } : undefined)
  return {
    ...value,
    assembly,
    lobbyStatus: value.lobbyStatus,
    currentRound,
    results: value.results || rawRound?.results,
    participants: value.participants,
    participantCount: value.participantCount,
    recordedCount: value.recordedCount ?? rawRound?.participationCount,
    participationStatus: value.participationStatus,
    eligibleCount: value.eligibleCount ?? value.participantCount ?? value.participants?.length,
  }
}

async function refresh() {
  if (loading.value) return
  if (role.value === 'participant' && sessionToken.value) {
    loading.value = true
    const requestToken = sessionToken.value
    try {
      const participantState = await request<Record<string, any>>('/participant/me', {}, requestToken)
      if (sessionToken.value !== requestToken) return
      state.value = normalizeState(participantState)
      error.value = ''
      const participantAssemblyId = String(participantState.assembly?.id || sessionAssemblyId.value)
      if (participantAssemblyId) {
        sessionAssemblyId.value = participantAssemblyId
        localStorage.setItem('participantAssemblyId', participantAssemblyId)
      }
      if (incomingJoinCode && participantAssemblyId) {
        const target = await request<Record<string, any>>(`/assemblies/${encodeURIComponent(incomingJoinCode)}/public-state`)
        const targetAssemblyId = String(target.assembly?.id || '')
        if (targetAssemblyId && targetAssemblyId !== participantAssemblyId) {
          pendingJoinCode.value = incomingJoinCode
          state.value = null
        }
        else {
          pendingJoinCode.value = ''
          code.value = incomingJoinCode
        }
      }
    } catch (e) {
      if (sessionToken.value !== requestToken) return
      if (!handleParticipantUnauthorized(e, requestToken) && !(state.value && realtimeActive.value && !realtimeConnected.value)) {
        error.value = (e as Error).message
      }
    } finally { loading.value = false }
  } else if (role.value === 'projector' && code.value) {
    loading.value = true
    try {
      state.value = normalizeState(await request<Record<string, any>>(`/assemblies/${encodeURIComponent(code.value)}/public-state`))
      error.value = ''
    }
    catch (e) { if (!state.value) error.value = (e as Error).message }
    finally { loading.value = false }
  } else if (role.value === 'moderator' && moderatorToken.value && assemblyId.value) {
    loading.value = true
    try {
      if (moderatorAuthState.value !== 'authenticated') {
        moderatorAuthState.value = 'validating'
        state.value = null
      }
      state.value = normalizeState(await request<Record<string, any>>(`/moderator/assemblies/${encodeURIComponent(assemblyId.value)}`, {}, moderatorToken.value))
      moderatorAuthState.value = 'authenticated'
      sessionStorage.setItem('moderatorToken', moderatorToken.value)
      error.value = ''
    }
    catch (e) {
      const message = (e as Error).message
      if (isUnauthorized(e)) {
        moderatorToken.value = ''
        moderatorAuthState.value = 'unauthenticated'
        state.value = null
        sessionStorage.removeItem('moderatorToken')
        error.value = 'La credencial guardada ya no es válida. Ingresa de nuevo la clave de moderación.'
      } else if (state.value && realtimeActive.value && !realtimeConnected.value) {
        error.value = ''
      } else {
        moderatorAuthState.value = 'validation_error'
        state.value = null
        error.value = message
      }
    }
    finally { loading.value = false }
  } else if (role.value === 'moderator' && moderatorToken.value) {
    loading.value = true
    moderatorAuthState.value = 'validating'
    try {
      await request('/moderator/session', {}, moderatorToken.value)
      moderatorAuthState.value = 'authenticated'
      sessionStorage.setItem('moderatorToken', moderatorToken.value)
      error.value = ''
    } catch (e) {
      const message = (e as Error).message
      state.value = null
      if (isUnauthorized(e)) {
        moderatorToken.value = ''
        moderatorAuthState.value = 'unauthenticated'
        sessionStorage.removeItem('moderatorToken')
        error.value = 'La credencial guardada ya no es válida. Ingresa de nuevo la clave de moderación.'
      } else {
        moderatorAuthState.value = 'validation_error'
        error.value = message
      }
    } finally { loading.value = false }
  }
}

async function join() {
  error.value = ''
  loading.value = true
  try {
    const joined = await request<Record<string, any>>(`/assemblies/${encodeURIComponent(code.value)}/join`, {
      method: 'POST', body: JSON.stringify({ firstName: firstName.value.trim(), lastName: lastName.value.trim() }),
    })
    sessionToken.value = joined.participantSessionToken
    sessionAssemblyId.value = String(joined.assembly?.id || '')
    localStorage.setItem('participantSessionToken', joined.participantSessionToken)
    if (sessionAssemblyId.value) localStorage.setItem('participantAssemblyId', sessionAssemblyId.value)
    pendingJoinCode.value = ''
    state.value = normalizeState(joined)
    notice.value = 'Te uniste a la sala. Tu teléfono queda en espera.'
    await refresh()
  } catch (e) {
    if (!handleParticipantUnauthorized(e, sessionToken.value)) {
      error.value = e instanceof ApiRequestError && e.status === 404
        ? 'El código no corresponde a una sala abierta. Revísalo con la mesa e inténtalo de nuevo.'
        : (e as Error).message
    }
  }
  finally { loading.value = false }
}

function leaveParticipantSession() {
  clearParticipantSession()
  pendingJoinCode.value = ''
  error.value = ''
  notice.value = 'Saliste de la sesión. Puedes ingresar otro delegado en este dispositivo.'
}

function switchToIncomingAssembly() {
  if (!pendingJoinCode.value) return
  code.value = pendingJoinCode.value
  clearParticipantSession()
  pendingJoinCode.value = ''
  error.value = ''
  notice.value = 'La sesión anterior se cerró en este dispositivo. Ingresa tus datos para unirte a la Asamblea del QR.'
}

function reviewVote() {
  if (!round.value || !selectedOptions.value.length || !reviewedOptions.value.length || loading.value || voteSubmitting.value) return
  error.value = ''
  notice.value = ''
  reviewingVote.value = true
}

async function submitVote() {
  if (!round.value || !selectedOptions.value.length || !reviewedOptions.value.length || !reviewingVote.value || loading.value || voteSubmitting.value) return
  error.value = ''
  notice.value = ''
  voteSubmitting.value = true
  loading.value = true
  let accepted = false
  try {
    await request(`/participant/rounds/${encodeURIComponent(round.value.id)}/vote`, {
      method: 'POST', body: JSON.stringify(round.value.format === 'multiple_choice'
        ? { optionIds: selectedOptions.value, confirmation: true }
        : { optionId: selectedOptions.value[0], confirmation: true }),
    }, sessionToken.value)
    notice.value = 'Tu participación fue registrada. Gracias.'
    selectedOptions.value = []
    reviewingVote.value = false
    accepted = true
  } catch (e) {
    if (!handleParticipantUnauthorized(e, sessionToken.value)) error.value = (e as Error).message
  }
  finally { loading.value = false; voteSubmitting.value = false }
  if (accepted) await refresh()
}

function toggleBallotOption(optionId: string, checked: boolean) {
  if (round.value?.format !== 'multiple_choice') {
    selectedOptions.value = checked ? [optionId] : []
    return
  }
  if (checked) {
    const maxChoices = round.value.memberCount
    if (maxChoices && selectedOptions.value.length >= maxChoices) {
      error.value = `Puedes seleccionar como máximo ${maxChoices} integrantes.`
      return
    }
    selectedOptions.value = [...selectedOptions.value, optionId]
  } else selectedOptions.value = selectedOptions.value.filter((id) => id !== optionId)
  error.value = ''
}

async function participantCommitteeAction(path: string, body?: unknown) {
  error.value = ''
  loading.value = true
  let succeeded = false
  try {
    await request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, sessionToken.value)
    notice.value = 'Acción registrada.'
    succeeded = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
  if (succeeded) await refresh()
}

async function configureCommittee(targetRound: NonNullable<PublicState['rounds']>[number]) {
  await moderatorAction(`/moderator/rounds/${encodeURIComponent(targetRound.id)}/committee/configuration`, 'PATCH', {
    memberCount: committeeMemberCount.value,
    decisionNote: committeeDecisionNote.value,
    committeeConfiguration: {
      institutionallyValidated: committeeInstitutionallyValidated.value,
      validationReference: committeeDecisionReference.value,
      eligibilityRule: committeeEligibilityRule.value,
      votingMethod: committeeVotingMethod.value,
      ...(targetRound.committeeType === 'nomination' ? {
        proposalRule: committeeProposalRule.value,
        ...(committeeSupportRule.value ? { supportRule: committeeSupportRule.value } : {}),
        supportMinimum: committeeSupportMinimum.value,
        ...(committeeApprovalDenominator.value ? { approvalDenominator: committeeApprovalDenominator.value } : {}),
      } : {}),
    },
  })
}

function editCommitteeConfiguration(targetRound: NonNullable<PublicState['rounds']>[number]) {
  const rules = targetRound.committeeConfiguration || {}
  committeeEditingRoundId.value = targetRound.id
  roundCategory.value = 'committee'
  committeeType.value = targetRound.committeeType || 'other'
  committeeMemberCount.value = targetRound.memberCount ?? null
  committeeDecisionNote.value = targetRound.decisionNote || ''
  committeeInstitutionallyValidated.value = rules.institutionallyValidated === true
  committeeDecisionReference.value = rules.validationReference || ''
  committeeEligibilityRule.value = rules.eligibilityRule || ''
  committeeVotingMethod.value = rules.votingMethod || ''
  committeeProposalRule.value = rules.proposalRule || ''
  committeeSupportRule.value = rules.supportRule || ''
  committeeSupportMinimum.value = rules.supportMinimum ?? null
  committeeApprovalDenominator.value = rules.approvalDenominator || ''
}

async function saveCommitteeConfiguration(targetRound: NonNullable<PublicState['rounds']>[number]) {
  await configureCommittee(targetRound)
  committeeEditingRoundId.value = ''
}

async function advanceCommitteeStage(targetRound: NonNullable<PublicState['rounds']>[number], stage: 'support' | 'approval' | 'election') {
  await moderatorAction(`/moderator/rounds/${encodeURIComponent(targetRound.id)}/committee/stage`, 'POST', { stage })
}

async function recordCommitteeApproval(targetRound: NonNullable<PublicState['rounds']>[number], proposalId: string) {
  const counts = committeeApprovalCounts.value[proposalId] || { yesVotes: 0, noVotes: 0 }
  await moderatorAction(`/moderator/rounds/${encodeURIComponent(targetRound.id)}/committee/proposals/${encodeURIComponent(proposalId)}/approval`, 'PUT', counts)
}

function updateCommitteeApproval(proposalId: string, field: 'yesVotes' | 'noVotes', value: string) {
  committeeApprovalCounts.value[proposalId] = { ...(committeeApprovalCounts.value[proposalId] || { yesVotes: 0, noVotes: 0 }), [field]: Number(value) }
}

async function updateParticipantCommitteeStatus(person: NonNullable<PublicState['participants']>[number]) {
  if (!person.id) return
  await moderatorAction(`/moderator/participants/${encodeURIComponent(person.id)}`, 'PATCH', {
    assemblyRole: person.assemblyRole,
    committeeEligible: person.committeeEligible,
  })
}

async function moderatorAction(path: string, method = 'POST', body?: unknown) {
  const removed = body && typeof body === 'object' && 'status' in body && body.status === 'removed'
  const config = path.endsWith('/lobby')
    ? { title: '¿Cerrar el ingreso?', consequence: 'Las personas que todavía no se hayan unido ya no podrán entrar.', label: 'Cerrar ingreso' }
    : path.endsWith('/rounds')
      ? { title: '¿Preparar esta papeleta?', consequence: 'Revisa el cargo y las opciones. No se podrán editar después de abrir la votación.', label: 'Preparar papeleta' }
      : path.endsWith('/open')
        ? { title: '¿Abrir la votación?', consequence: 'La papeleta aparecerá en los teléfonos y sus opciones quedarán fijas.', label: 'Abrir votación' }
        : path.endsWith('/close')
          ? { title: '¿Cerrar la votación?', consequence: 'Dejará de aceptar votos. Los resultados seguirán ocultos hasta que la mesa decida publicarlos.', label: 'Cerrar votación' }
          : path.endsWith('/publish')
            ? { title: '¿Publicar resultados?', consequence: 'Los conteos agregados se harán visibles para participantes y proyector.', label: 'Publicar resultados' }
            : removed
              ? { title: '¿Retirar a esta persona?', consequence: 'Ya no podrá participar desde esta sesión.', label: 'Retirar participante' }
              : { title: '¿Guardar los cambios?', consequence: 'Se actualizarán los datos de esta persona en la lista.', label: 'Guardar cambios' }
  moderationConfirmation.value = { ...config, path, method, ...(body === undefined ? {} : { body }) }
}

async function confirmModeratorAction() {
  const action = moderationConfirmation.value
  if (!action || loading.value) return
  moderationConfirmation.value = null
  error.value = ''
  loading.value = true
  let succeeded = false
  try {
    await request(action.path, { method: action.method, ...(action.body === undefined ? {} : { body: JSON.stringify(action.body) }) }, moderatorToken.value)
    notice.value = 'Acción registrada.'
    succeeded = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
  if (succeeded && action.path.endsWith('/complete')) notice.value = 'La Asamblea quedó finalizada y disponible en modo de consulta.'
  if (succeeded) await refresh()
}

async function completeAssembly() {
  if (!assemblyId.value || assemblyStatus.value === 'completed' || round.value?.status === 'open') return
  moderationConfirmation.value = {
    title: '¿Finalizar la Asamblea?',
    consequence: 'Confirma solo después de que la mesa haya aprobado el cierre. La sesión quedará en modo de consulta.',
    label: 'Finalizar Asamblea',
    path: `/moderator/assemblies/${encodeURIComponent(assemblyId.value)}/complete`,
    method: 'POST', body: { confirmation: true },
  }
}

async function createAssembly() {
  error.value = ''
  loading.value = true
  let created = false
  try {
    const result = await request<{ assemblyId: string; joinCode: string; joinUrl?: string }>('/moderator/assemblies', {
      method: 'POST', body: JSON.stringify({ name: assemblyName.value }),
    }, moderatorToken.value)
    assemblyId.value = result.assemblyId
    sessionStorage.setItem('assemblyId', result.assemblyId)
    code.value = result.joinCode
    localStorage.setItem('assemblyJoinCode', result.joinCode)
    qrImage.value = await QRCode.toDataURL(result.joinUrl || `${window.location.origin}/?join=${encodeURIComponent(result.joinCode)}`, { width: 300, margin: 2 })
    notice.value = `Asamblea creada. Código de ingreso: ${result.joinCode}`
    created = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
  if (created) await refresh()
}

async function refreshQr() {
  if (!code.value) { qrImage.value = ''; return }
  qrImage.value = await QRCode.toDataURL(`${origin}/?join=${encodeURIComponent(code.value)}`, { width: 420, margin: 2 })
}

function editParticipant(person: { id?: string; firstName: string; lastName: string }) {
  if (!person.id) return
  const updatedFirst = window.prompt('Corrige el nombre del participante:', person.firstName)
  if (updatedFirst === null) return
  const updatedLast = window.prompt('Corrige el apellido del participante:', person.lastName)
  if (updatedLast === null) return
  void moderatorAction(`/moderator/participants/${encodeURIComponent(person.id)}`, 'PATCH', {
    firstName: updatedFirst.trim(), lastName: updatedLast.trim(),
  })
}

async function createRound() {
  const options = roundCategory.value === 'committee' && committeeType.value !== 'nomination'
    ? eligibleCommitteeCandidates.value.filter((person) => person.id && committeeCandidateSelections.value.includes(person.id))
      .map((person) => ({ label: `${person.firstName} ${person.lastName}`, candidateParticipantId: person.id }))
    : optionsText.value.split('\n').map((label) => label.trim()).filter(Boolean).map((label) => ({ label }))
  if (roundCategory.value === 'office' && options.length < 2) { error.value = 'Agrega al menos dos opciones, una por línea.'; return }
  if (roundCategory.value === 'committee' && committeeType.value !== 'nomination' && options.length === 0) { error.value = 'Selecciona participantes con elegibilidad confirmada o deja el proceso bloqueado hasta validar la lista.'; return }
  showNextBallotForm.value = false
  await moderatorAction(`/moderator/assemblies/${encodeURIComponent(assemblyId.value)}/rounds`, 'POST', {
    title: roundTitle.value, format: roundCategory.value === 'committee' ? 'multiple_choice' : 'single_choice', options,
    category: roundCategory.value,
    ...(roundCategory.value === 'committee' ? {
      committeeType: committeeType.value,
      ...(committeeMemberCount.value ? { memberCount: committeeMemberCount.value } : {}),
      decisionNote: committeeDecisionNote.value,
      committeeConfiguration: {
        institutionallyValidated: committeeInstitutionallyValidated.value,
        validationReference: committeeDecisionReference.value,
        eligibilityRule: committeeEligibilityRule.value,
        votingMethod: committeeVotingMethod.value,
        ...(committeeType.value === 'nomination' ? {
          proposalRule: committeeProposalRule.value,
          ...(committeeSupportRule.value ? { supportRule: committeeSupportRule.value } : {}),
          ...(committeeSupportMinimum.value ? { supportMinimum: committeeSupportMinimum.value } : {}),
          ...(committeeApprovalDenominator.value ? { approvalDenominator: committeeApprovalDenominator.value } : {}),
        } : {}),
      },
    } : {}),
    countingRule: { kind: 'count_only', label: 'Conteo agregado por opción; sin proclamación automática' },
  })
}

async function saveOfficialResult(targetRound: NonNullable<PublicState['rounds']>[number]) {
  const optionIds = officialSelections.value[targetRound.id] || []
  if (!optionIds.length) { error.value = 'Selecciona al menos una persona u opción declarada por la mesa.'; return }
  await moderatorAction(`/moderator/rounds/${encodeURIComponent(targetRound.id)}/official-result`, 'PUT', {
    optionIds, note: officialNotes.value[targetRound.id] || '',
  })
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-HN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatActor(actor: string) {
  return actor === 'shared_moderator_credential' ? 'moderación (credencial compartida)' : actor
}

async function signInModerator() {
  const credential = moderatorCredential.value.trim()
  if (!credential) return
  moderatorAuthState.value = 'validating'
  moderatorToken.value = credential
  state.value = null
  error.value = ''
  try {
    await request('/moderator/session', {}, credential)
    moderatorAuthState.value = 'authenticated'
    sessionStorage.setItem('moderatorToken', credential)
    error.value = ''
    if (assemblyId.value) void refresh()
  } catch (e) {
    const message = (e as Error).message
    state.value = null
    if (isUnauthorized(e)) {
      moderatorToken.value = ''
      moderatorAuthState.value = 'unauthenticated'
      sessionStorage.removeItem('moderatorToken')
      error.value = 'La credencial de moderación no es válida.'
    } else {
      moderatorAuthState.value = 'validation_error'
      error.value = message
    }
  }
}

function syncRealtime() {
  realtimeSocket?.disconnect()
  realtimeSocket = null
  realtimeActive.value = false
  realtimeConnected.value = false
  let auth: Record<string, string> | null = null
  if (role.value === 'participant' && sessionToken.value) auth = { audience: 'participant', participantSessionToken: sessionToken.value }
  else if (role.value === 'moderator' && moderatorToken.value && assemblyId.value) auth = { audience: 'moderator', moderatorCredential: moderatorToken.value, assemblyId: assemblyId.value }
  else if (role.value === 'projector' && code.value) auth = { audience: 'public', assemblyCode: code.value }
  if (!auth) return
  const socketUrl = import.meta.env.VITE_SOCKET_URL || `${API.replace(/\/api\/v1\/?$/, '')}/events`
  realtimeActive.value = true
  realtimeSocket = io(socketUrl, { auth, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelayMax: 5000 })
  for (const event of ['assembly.state', 'lobby.state', 'participant.joined', 'participant.updated', 'participant.removed', 'participant.state', 'round.state', 'round.opened', 'round.closed', 'participation.count', 'results.published']) {
    realtimeSocket.on(event, () => { void refresh() })
  }
  realtimeSocket.on('connect', () => { realtimeConnected.value = true; void refresh() })
  realtimeSocket.on('disconnect', () => { realtimeConnected.value = false })
  realtimeSocket.on('connect_error', () => { realtimeConnected.value = false })
}

onMounted(() => {
  document.addEventListener('fullscreenchange', syncProjectorFullscreen)
  window.addEventListener('popstate', () => {
    const nextRoute = window.location.pathname
    if (nextRoute.startsWith('/moderator')) {
      moderatorAuthState.value = moderatorToken.value ? 'validating' : 'unauthenticated'
      state.value = null
    } else if (role.value === 'moderator') state.value = null
    route.value = nextRoute
    void refresh()
  })
  void refresh()
  void refreshQr()
  syncRealtime()
  refreshTimer = window.setInterval(() => {
    if (!loading.value && !(role.value === 'moderator' && moderatorAuthState.value === 'validation_error')) void refresh()
  }, 7000)
})
watch([route, sessionToken, moderatorToken, code], () => syncRealtime())
watch(code, () => { void refreshQr() })
onUnmounted(() => { if (refreshTimer) window.clearInterval(refreshTimer); realtimeSocket?.disconnect(); document.removeEventListener('fullscreenchange', syncProjectorFullscreen) })
</script>

<template>
  <header v-if="role !== 'projector'" class="topbar" :class="{ 'topbar-session': role === 'participant' && !!sessionToken }">
    <a class="brand" href="/" @click.prevent="go('/')"><span class="brand-mark">A</span><span>ASDMR <small>Unión Hondureña</small></span></a>
    <nav v-if="role === 'moderator'" aria-label="Vistas de mesa">
      <a href="/" @click.prevent="go('/')">Delegado</a>
      <a :href="`/projector${code ? `?code=${encodeURIComponent(code)}` : ''}`" @click.prevent="openProjectorWindow">Abrir proyector</a>
    </nav>
  </header>

  <main :class="['page', `${role}-page`, { 'projector-page': role === 'projector', 'participant-session-page': role === 'participant' && !!sessionToken }]">
    <p v-if="role !== 'projector' && realtimeActive && !realtimeConnected && !(role === 'moderator' && moderatorAuthState === 'validation_error')" class="connection-warning" role="status" aria-live="polite">Conexión interrumpida · Intentando reconectar. Los datos mostrados son los últimos confirmados.</p>
    <div v-if="error && !(role === 'moderator' && moderatorAuthState === 'validation_error')" class="notice error" role="alert"><strong v-if="!(role === 'participant' && !sessionToken && error.startsWith('El código no corresponde'))">Ocurrió un problema.</strong>{{ error }}</div>
    <div v-if="notice" class="notice success" role="status">{{ notice }}</div>
    <p v-if="loading" class="sync" aria-live="polite">Actualizando estado…</p>
    <div v-if="role === 'moderator' && moderationConfirmation" class="confirmation-backdrop" @click.self="moderationConfirmation = null">
      <section class="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="moderation-confirm-title" aria-describedby="moderation-confirm-description">
        <p class="eyebrow">CONFIRMACIÓN DE MESA</p>
        <h2 id="moderation-confirm-title">{{ moderationConfirmation.title }}</h2>
        <p id="moderation-confirm-description">{{ moderationConfirmation.consequence }}</p>
        <div class="confirmation-actions">
          <button class="secondary" :disabled="loading" @click="moderationConfirmation = null">Cancelar</button>
          <button :class="moderationConfirmation.path.endsWith('/complete') || moderationConfirmation.path.endsWith('/close') || moderationConfirmation.path.includes('/participants/') ? 'danger' : 'primary'" :disabled="loading" @click="confirmModeratorAction">{{ loading ? 'Guardando…' : moderationConfirmation.label }}</button>
        </div>
      </section>
    </div>

    <template v-if="role === 'participant'">
      <section v-if="!sessionToken" class="card join-card">
        <p class="eyebrow">ASAMBLEA DE DELEGADOS</p>
        <h1>Bienvenido</h1>
        <p class="lead">Ingresa con el código mostrado por la mesa y escribe tu nombre para unirte a la sala.</p>
        <form @submit.prevent="join">
          <label>Código de sala<input v-model="code" autocomplete="off" required placeholder="Código de la Asamblea" /></label>
          <div class="field-row">
            <label>Nombre<input v-model="firstName" autocomplete="given-name" required maxlength="80" /></label>
            <label>Apellido<input v-model="lastName" autocomplete="family-name" required maxlength="100" /></label>
          </div>
          <button class="primary" :disabled="loading">{{ loading ? 'Uniéndote…' : 'Unirme a la sala' }}</button>
        </form>
        <p class="privacy-note">El ingreso por nombre facilita el control en sala, pero no acredita identidad ni condición de delegado.</p>
      </section>
      <section v-else class="card participant-card">
        <div class="participant-session-actions"><button class="link-button" @click="leaveParticipantSession">Salir / cambiar de participante</button></div>
        <div v-if="pendingJoinCode" class="notice error" role="alert">
          Este QR corresponde a otra Asamblea. La sesión actual sigue abierta en este dispositivo.
          <button class="secondary" @click="switchToIncomingAssembly">Cerrar sesión y cambiar a la Asamblea del QR</button>
        </div>
        <p class="eyebrow">{{ state?.assembly?.name || 'ASAMBLEA' }}</p>
        <h1>{{ assemblyStatus === 'completed' ? 'Asamblea finalizada' : round?.status === 'open' ? round.title : 'Sala de espera' }}</h1>
        <div v-if="assemblyStatus === 'completed'" class="status-panel assembly-completed" role="status"><span class="status-dot"></span><div><strong>La sesión concluyó</strong><p>Esta Asamblea está en modo de consulta.<template v-if="completionTime"> Se finalizó {{ completionTime }}.</template></p></div></div>
        <template v-if="state?.participationStatus === 'recorded'">
          <div class="status-panel"><span class="status-dot"></span><div><strong>Tu participación está registrada</strong><p>La papeleta fue confirmada y no puede cambiarse. No se muestra aquí la opción seleccionada.</p></div></div>
          <section v-if="round?.status === 'published' && state?.results?.length" class="participant-results" aria-labelledby="participant-results-title">
            <p class="eyebrow">RESULTADOS PUBLICADOS</p><h2 id="participant-results-title">{{ round.title }}</h2>
            <ul class="participant-results-list"><li v-for="result in state.results" :key="result.label"><span>{{ result.label }}</span><strong>{{ result.count }} {{ result.count === 1 ? 'voto' : 'votos' }}</strong></li></ul>
            <p class="participant-results-total">Total: {{ state.results.reduce((total, result) => total + result.count, 0) }} {{ state.results.reduce((total, result) => total + result.count, 0) === 1 ? 'voto' : 'votos' }}</p>
          </section>
        </template>
        <section v-if="state?.results?.length" class="participant-published-results"><p class="eyebrow">RESULTADOS PUBLICADOS</p><div class="results-list"><div v-for="result in state.results" :key="result.label"><span>{{ result.label }}</span><strong>{{ result.count }}</strong></div></div><div v-if="state.officialResult" class="projector-official-result"><p class="eyebrow">RESULTADO OFICIAL DE LA MESA</p><h2>{{ state.officialResult.elected.map((person) => person.label).join(' · ') }}</h2><p v-if="state.officialResult.note">{{ state.officialResult.note }}</p></div></section>
        <template v-else-if="round?.status === 'open' && round.options?.length && reviewingVote">
          <section class="vote-review" aria-labelledby="vote-review-title">
            <p class="eyebrow">REVISIÓN DEL VOTO</p>
            <h2 id="vote-review-title" ref="reviewHeading" tabindex="-1">Confirma tu selección</h2>
            <dl class="review-details">
              <div><dt>Papeleta</dt><dd>{{ round.title }}</dd></div>
              <div><dt>Selección</dt><dd>{{ reviewedOptions.map((option) => option.label).join(', ') || 'La selección ya no está disponible.' }}</dd></div>
            </dl>
            <p class="privacy-note">Después de confirmar, tu voto será definitivo y no podrás cambiarlo.</p>
            <div class="review-actions">
              <button class="secondary" :disabled="loading" @click="reviewingVote = false">Volver a la papeleta</button>
              <button class="primary" :disabled="loading || !reviewedOptions.length" @click="submitVote">{{ voteSubmitting ? 'Enviando voto…' : 'Confirmar voto' }}</button>
            </div>
          </section>
        </template>
        <template v-else-if="round?.status === 'open' && round.options?.length">
          <p class="lead">{{ round.format === 'multiple_choice' ? `Selecciona hasta ${round.memberCount ?? 'el límite indicado'} integrantes, revisa y confirma.` : 'Selecciona una opción, revísala y confirma cuando estés listo.' }}</p>
          <fieldset class="options"><legend>Opciones de la papeleta</legend>
            <label v-for="option in round.options" :key="option.id" class="option"><input :type="round.format === 'multiple_choice' ? 'checkbox' : 'radio'" name="option" :value="option.id" :checked="selectedOptions.includes(option.id)" @change="toggleBallotOption(option.id, ($event.target as HTMLInputElement).checked)" /><span>{{ option.label }}</span></label>
          </fieldset>
          <button class="primary" :disabled="loading || voteSubmitting || !selectedOptions.length" @click="reviewVote">Revisar y confirmar voto</button>
          <p class="privacy-note">Tu selección es definitiva después de confirmarla.</p>
        </template>
        <template v-else-if="round?.category === 'committee' && round.committeeStage === 'proposals'">
          <section class="card"><p class="eyebrow">COMISIÓN DE NOMBRAMIENTO</p><h2>Registrar propuesta</h2><p class="lead">Presenta una candidatura de la lista confirmada como elegible por moderación. No se admiten personas con los cargos excluidos.</p><form @submit.prevent="participantCommitteeAction(`/participant/rounds/${encodeURIComponent(round.id)}/committee/proposals`, { candidateParticipantId: participantCandidateSelection })"><label>Candidatura<select v-model="participantCandidateSelection" required><option value="" disabled>Selecciona un delegado elegible</option><option v-for="candidate in state?.committeeCandidates || []" :key="candidate.id" :value="candidate.id">{{ candidate.firstName }} {{ candidate.lastName }}</option></select></label><button class="primary" :disabled="loading || !participantCandidateSelection">Registrar propuesta</button></form><ul class="option-list"><li v-for="proposal in state?.committeeProposals || []" :key="proposal.id">{{ proposal.candidateName }}</li></ul></section>
        </template>
        <template v-else-if="round?.category === 'committee' && round.committeeStage === 'support'">
          <section class="card"><p class="eyebrow">COMISIÓN DE NOMBRAMIENTO</p><h2>Apoyar propuestas</h2><p class="lead">Cada delegado elegible puede registrar un apoyo por propuesta. Solo se muestra el total, no quién apoyó.</p><ul class="participant-list"><li v-for="proposal in state?.committeeProposals || []" :key="proposal.id"><span>{{ proposal.candidateName }} · {{ proposal.supportCount }} apoyos</span><button class="secondary" :disabled="loading || proposal.supportedByMe" @click="participantCommitteeAction(`/participant/rounds/${encodeURIComponent(round.id)}/committee/proposals/${encodeURIComponent(proposal.id)}/support`)">{{ proposal.supportedByMe ? 'Apoyo registrado' : 'Apoyar' }}</button></li></ul></section>
        </template>
        <div v-else-if="round?.category === 'committee' && round.committeeStage === 'configuration_required'" class="status-panel"><span class="status-dot"></span><div><strong>La comisión aún no está lista para votar</strong><p>Secretaría o la mesa debe validar elegibilidad, método y las reglas pendientes.</p></div></div>
        <div v-else class="status-panel"><span class="status-dot"></span><div><strong>{{ round?.status === 'closed' ? 'La papeleta está cerrada' : 'Esperando la siguiente papeleta' }}</strong><p>La mesa anunciará cuando comience la votación.</p></div></div>
      </section>
    </template>

    <template v-else-if="role === 'moderator'">
      <section v-if="moderatorAuthState === 'validating'" class="card join-card" aria-live="polite">
        <p class="eyebrow">ACCESO DE MESA</p><h1>Verificando acceso</h1>
        <p class="lead">Estamos validando la credencial con el servidor.</p>
      </section>
      <section v-else-if="moderatorAuthState === 'validation_error'" class="validation-state">
        <header class="validation-heading"><p class="eyebrow">PANEL DE MODERACIÓN</p><h1>Error de validación</h1></header>
        <section class="card join-card validation-card">
          <p class="eyebrow">ACCESO DE MESA</p><h2>No se pudo validar el acceso</h2>
          <p class="lead">La credencial se conserva. Comprueba la conexión e inténtalo de nuevo.</p>
          <button class="primary" :disabled="loading" @click="refresh">{{ loading ? 'Reintentando…' : 'Reintentar validación' }}</button>
        </section>
      </section>
      <section v-else-if="moderatorAuthState !== 'authenticated'" class="card join-card">
        <p class="eyebrow">ACCESO DE MESA</p><h1>Moderación</h1>
        <p class="lead">Ingresa la credencial operativa autorizada por la organización.</p>
        <form @submit.prevent="signInModerator"><label>Credencial de moderación<input v-model="moderatorCredential" type="password" autocomplete="current-password" required /></label><button class="primary">Continuar</button></form>
      </section>
      <template v-else-if="moderatorAuthState === 'authenticated'">
        <section class="page-heading"><div class="heading-copy"><p class="eyebrow">PANEL DE MODERACIÓN</p><h1>Control de Asamblea</h1><p>{{ moderatorSessionSummary }}</p></div><div class="heading-projector"><button class="primary" @click="openProjectorWindow">Abrir proyector en otra ventana</button><p>La moderación permanece en esta ventana privada; la pantalla externa muestra solo la vista pública.</p></div></section>
        <section v-if="!assemblyId" class="card"><h2>Crear Asamblea</h2><form @submit.prevent="createAssembly"><label>Nombre<input v-model="assemblyName" required /></label><button class="primary" :disabled="loading">Crear Asamblea y generar código</button></form></section>
        <template v-else>
          <ol class="workflow-steps" aria-label="Pasos de la moderación">
            <li v-for="(step, index) in moderatorWorkflow" :key="step" :class="{ complete: index < moderatorWorkflowStep, current: index === moderatorWorkflowStep }" :aria-current="index === moderatorWorkflowStep ? 'step' : undefined">
              <span class="workflow-step-number">{{ index + 1 }}</span><span>{{ step }}</span>
            </li>
          </ol>
          <section class="summary-grid">
            <div class="card metric"><span>Estado</span><strong>{{ round?.status === 'published' ? 'Resultados publicados' : round?.status === 'closed' ? 'Votación cerrada' : round?.status === 'open' ? 'Votación abierta' : lobbyStatus === 'lobby_open' ? 'Ingreso abierto' : assemblyStatus }}</strong></div>
            <div class="card metric"><span>Participación</span><strong v-if="round">{{ state?.recordedCount ?? 0 }}<small> / {{ eligibleVotes }} {{ eligibleVotes === 1 ? 'voto' : 'votos' }}</small></strong><strong v-else>{{ totalParticipants }} {{ totalParticipants === 1 ? 'participante' : 'participantes' }}</strong></div>
            <div class="card metric"><span>Papeleta</span><strong>{{ round?.status === 'published' ? 'Publicada' : round?.status === 'closed' ? 'Cerrada' : round ? 'Preparada' : 'Sin iniciar' }}</strong></div>
          </section>
          <section v-if="assemblyStatus === 'completed'" class="status-panel assembly-completed" role="status"><span class="status-dot"></span><div><strong>Asamblea finalizada</strong><p>El sistema está en modo de consulta.<template v-if="completionTime"> Se registró {{ completionTime }}.</template></p></div></section>
          <template v-else>
          <section class="card"><div class="section-heading"><div><p class="eyebrow">INGRESO</p><h2>Participantes</h2></div><button class="secondary" @click="refresh">Actualizar lista</button></div>
            <ul class="participant-list"><li v-for="(person, index) in state?.participants || []" :key="person.id || `${person.firstName}-${person.lastName}-${index}`"><div><span>{{ person.firstName }} {{ person.lastName }}</span><div v-if="person.id" class="committee-profile"><label>Rol para reglas de comisión<select v-model="person.assemblyRole" @change="updateParticipantCommitteeStatus(person)"><option value="">Sin confirmar</option><option value="delegate">Delegado</option><option value="president">Presidente</option><option value="vice_president">Vicepresidente</option><option value="secretary">Secretario</option><option value="treasurer">Tesorero</option></select></label><label class="checkbox-label"><input v-model="person.committeeEligible" type="checkbox" @change="updateParticipantCommitteeStatus(person)" /> Elegibilidad confirmada por Secretaría/mesa</label></div></div><span v-if="person.id && (assemblyStatus === 'lobby_open' || assemblyStatus === 'lobby_closed')" class="person-actions"><button class="link-button" @click="editParticipant(person)">Corregir</button><button class="link-button remove-link" @click="moderatorAction(`/moderator/participants/${encodeURIComponent(person.id)}`, 'PATCH', { status: 'removed' })">Retirar</button></span></li><li v-if="!state?.participants?.length" class="empty">La lista aparecerá aquí cuando se unan.</li></ul>
            <div class="action-row"><button v-if="lobbyStatus === 'lobby_open'" class="secondary" :disabled="loading" @click="moderatorAction(`/moderator/assemblies/${assemblyId}/lobby`, 'PATCH', { status: 'lobby_closed' })">Cerrar ingreso</button><span v-else class="status-line">El ingreso está cerrado.</span><a v-if="code" class="text-link" :href="`/?join=${encodeURIComponent(code)}`">Código: {{ code }}</a></div>
            <div v-if="qrImage" class="qr-panel"><img :src="qrImage" alt="Código QR para unirse a la Asamblea" /><div><strong>Escanea para unirte</strong><p>Abre este enlace en el proyector y muestra el código QR durante el ingreso.</p><a :href="`/?code=${encodeURIComponent(code)}`">{{ origin }}/?code={{ code }}</a></div></div>
          </section>
          <section class="card"><p class="eyebrow">PAPELETA</p><h2>{{ round?.title || 'Preparar votación' }}</h2>
            <div v-if="round?.status === 'open'" class="action-row"><p class="status-line">La votación está abierta. Los resultados permanecerán ocultos hasta que la mesa los publique.</p><button class="danger" :disabled="loading" @click="moderatorAction(`/moderator/rounds/${encodeURIComponent(round.id)}/close`)">Cerrar votación</button></div>
            <div v-else-if="round?.status === 'closed'" class="action-row"><p class="status-line">La papeleta está cerrada. Revisa el conteo antes de publicarlo.</p><button class="primary" :disabled="loading" @click="moderatorAction(`/moderator/rounds/${encodeURIComponent(round.id)}/publish`)">Publicar resultados</button></div>
            <template v-if="!round || round.status === 'published' || round.status === 'closed'">
              <form @submit.prevent="createRound"><label>Tipo de proceso<select v-model="roundCategory"><option value="office">Cargo</option><option value="committee">Comisión temporal</option></select></label><label>{{ roundCategory === 'committee' ? 'Nombre de la comisión o proceso' : 'Título o cargo' }}<input v-model="roundTitle" required :placeholder="roundCategory === 'committee' ? 'Ej. Comisión de Finanzas' : 'Ej. Elección de presidencia'" /></label>
                <template v-if="roundCategory === 'committee'">
                  <label>Tipo de comisión<select v-model="committeeType"><option value="nomination">Nombramiento</option><option value="finance">Finanzas</option><option value="statutes">Estatutos</option><option value="plans">Planes</option><option value="other">Otra comisión autorizada</option></select></label>
                  <label>Número de integrantes <span class="hint">Lo confirma Secretaría/mesa; Nombramiento requiere impar, mínimo cinco.</span><input v-model.number="committeeMemberCount" type="number" min="1" :max="committeeType === 'nomination' ? 99 : 70" :step="committeeType === 'nomination' ? 2 : 1" placeholder="Pendiente de decisión" /></label>
                  <label class="checkbox-label"><input v-model="committeeInstitutionallyValidated" type="checkbox" /> Configuración validada por Secretaría o la mesa</label>
                  <label>Referencia de la decisión institucional<input v-model="committeeDecisionReference" maxlength="200" placeholder="Acta, acuerdo o referencia" /></label>
                  <label>Decisión/validación de Secretaría o mesa<textarea v-model="committeeDecisionNote" rows="2" maxlength="1000" placeholder="Describe la decisión que valida este proceso"></textarea></label>
                  <label>Regla de elegibilidad validada<textarea v-model="committeeEligibilityRule" rows="2" maxlength="1000" placeholder="Quiénes pueden ser candidatos y electores"></textarea></label>
                  <label>Método de votación validado<textarea v-model="committeeVotingMethod" rows="2" maxlength="1000" placeholder="Método confirmado y tratamiento de abstenciones/nulos si aplica"></textarea></label>
                  <template v-if="committeeType === 'nomination'"><label>Regla validada para presentar propuestas<select v-model="committeeProposalRule"><option value="">Pendiente de decisión institucional</option><option value="eligible_delegate_only">Solo delegados elegibles pueden presentar</option></select></label><label>Regla validada para registrar apoyos<select v-model="committeeSupportRule"><option value="">Pendiente de decisión institucional</option><option value="one_per_eligible_delegate">Un apoyo por delegado elegible y por propuesta</option></select></label><label>Mínimo de apoyos requerido<input v-model.number="committeeSupportMinimum" type="number" min="1" placeholder="Definido por Secretaría/mesa" /></label><label>Base de mayoría simple<select v-model="committeeApprovalDenominator"><option value="">Pendiente de decisión institucional</option><option value="eligible_delegates">Delegados elegibles confirmados</option><option value="valid_votes">Votos válidos emitidos (sí + no)</option></select></label><p class="status-line">El flujo permanece bloqueado hasta validar la regla y el mínimo de apoyos, y la base del denominador para mayoría simple.</p></template>
                  <template v-else><fieldset class="official-options"><legend>Candidaturas/integrantes con elegibilidad confirmada</legend><label v-for="candidate in eligibleCommitteeCandidates" :key="candidate.id"><input v-model="committeeCandidateSelections" type="checkbox" :value="candidate.id" />{{ candidate.firstName }} {{ candidate.lastName }}</label><p v-if="!eligibleCommitteeCandidates.length" class="status-line">Primero confirma roles y elegibilidad en la lista de participantes.</p></fieldset></template>
                  <p class="privacy-note">Los votos de la elección son secretos. Si falta una validación, el proceso queda bloqueado y no se puede abrir.</p>
                </template>
                <label v-else>Opciones o candidaturas <span class="hint">Una por línea</span><textarea v-model="optionsText" rows="4" required placeholder="Nombre o descripción de cada opción"></textarea></label><button class="primary" :disabled="loading">{{ roundCategory === 'committee' ? 'Guardar configuración de comisión' : 'Preparar papeleta' }}</button></form>
            </template>
          </section>
          <section v-if="assemblyStatus !== 'preparing' && round?.status !== 'published'" class="card assembly-close"><p class="eyebrow">CIERRE DE SESIÓN</p><h2>Finalizar Asamblea</h2><p>Registra el cierre después de que la mesa haya aprobado la decisión. Se conservarán resultados y registros para consulta.</p><p v-if="round?.status === 'open'" class="status-line">Cierra la papeleta abierta antes de finalizar la Asamblea.</p><button class="danger" :disabled="loading || round?.status === 'open'" @click="completeAssembly">Finalizar Asamblea</button></section>
          </template>
          <section v-if="state?.rounds?.length" class="card official-history">
            <p class="eyebrow">ACTA DE RESULTADOS</p><h2>Declaraciones oficiales de la mesa</h2>
            <article v-for="historyRound in state.rounds" :key="historyRound.id" class="official-round">
              <div class="section-heading"><div><h3>{{ historyRound.title }}</h3><p class="status-line">{{ historyRound.category === 'committee' ? `Comisión · ${historyRound.committeeType} · ${historyRound.memberCount ?? 'tamaño pendiente'}` : 'Cargo' }} · conteo {{ historyRound.status === 'published' ? 'publicado' : historyRound.status === 'closed' ? 'cerrado' : historyRound.status }}</p><p v-if="historyRound.decisionNote" class="status-line">Configuración institucional: {{ historyRound.decisionNote }}</p></div></div>
              <template v-if="historyRound.category === 'committee'">
                <p class="status-line">Etapa: {{ historyRound.committeeStage || 'configuration_required' }}<span v-if="historyRound.committeeConfiguration?.validationReference"> · Validación: {{ historyRound.committeeConfiguration.validationReference }}</span></p>
                <p v-if="historyRound.committeeConfiguration" class="status-line">Elegibilidad: {{ historyRound.committeeConfiguration.eligibilityRule || 'pendiente' }} · Método: {{ historyRound.committeeConfiguration.votingMethod || 'pendiente' }}</p>
                <button v-if="historyRound.status === 'draft' && ['configuration_required', 'proposals', 'support'].includes(historyRound.committeeStage || '')" class="secondary" @click="editCommitteeConfiguration(historyRound)">{{ historyRound.committeeStage === 'support' ? 'Corregir configuración de apoyos' : historyRound.committeeStage === 'proposals' ? 'Editar configuración institucional' : 'Completar configuración institucional' }}</button>
                <form v-if="committeeEditingRoundId === historyRound.id" class="official-form" @submit.prevent="saveCommitteeConfiguration(historyRound)">
                  <label class="checkbox-label"><input v-model="committeeInstitutionallyValidated" type="checkbox" /> Validada por Secretaría/mesa</label>
                  <label>Referencia de decisión<input v-model="committeeDecisionReference" required /></label>
                  <label>Decisión institucional<textarea v-model="committeeDecisionNote" required rows="2"></textarea></label>
                  <label>Elegibilidad<textarea v-model="committeeEligibilityRule" required rows="2"></textarea></label>
                  <label>Método de votación<textarea v-model="committeeVotingMethod" required rows="2"></textarea></label>
                  <label>Tamaño confirmado<input v-model.number="committeeMemberCount" type="number" min="1" required /></label>
                  <template v-if="historyRound.committeeType === 'nomination'"><label>Regla de propuestas<select v-model="committeeProposalRule" required><option value="">Pendiente</option><option value="eligible_delegate_only">Solo delegados elegibles pueden presentar</option></select></label><label>Regla de apoyos<select v-model="committeeSupportRule" required><option value="">Pendiente</option><option value="one_per_eligible_delegate">Un apoyo por delegado elegible y por propuesta</option></select></label><label>Mínimo de apoyos<input v-model.number="committeeSupportMinimum" type="number" min="1" required /></label><label>Base para mayoría<select v-model="committeeApprovalDenominator"><option value="">Pendiente</option><option value="eligible_delegates">Delegados elegibles</option><option value="valid_votes">Votos válidos</option></select></label></template>
                  <button class="primary" :disabled="loading">Guardar validación</button>
                </form>
                <div v-if="historyRound.committeeProposals?.length" class="committee-proposals">
                  <h4>Propuestas, apoyos y aprobación</h4>
                  <ul class="option-list"><li v-for="proposal in historyRound.committeeProposals" :key="proposal.id">{{ proposal.candidateName }} · {{ proposal.supportCount }} apoyos · {{ proposal.status }}<span v-if="proposal.approvalYes !== null"> · aprobación agregada: {{ proposal.approvalYes }} sí / {{ proposal.approvalNo }} no</span></li></ul>
                  <div v-if="historyRound.committeeStage === 'approval'" v-for="proposal in historyRound.committeeProposals" :key="`approval-${proposal.id}`" class="approval-entry">
                    <strong>{{ proposal.candidateName }}</strong><label>Sí<input type="number" min="0" :value="committeeApprovalCounts[proposal.id]?.yesVotes ?? 0" @input="updateCommitteeApproval(proposal.id, 'yesVotes', ($event.target as HTMLInputElement).value)" /></label><label>No<input type="number" min="0" :value="committeeApprovalCounts[proposal.id]?.noVotes ?? 0" @input="updateCommitteeApproval(proposal.id, 'noVotes', ($event.target as HTMLInputElement).value)" /></label><button class="secondary" @click="recordCommitteeApproval(historyRound, proposal.id)">Registrar conteo agregado</button>
                  </div>
                </div>
                <ul v-if="historyRound.committeeComposition?.length" class="option-list"><li v-for="winner in historyRound.committeeComposition" :key="winner.participantId">Composición provisional {{ winner.order }}: {{ winner.name }}</li></ul>
                <div class="action-row" v-if="historyRound.status === 'draft' && historyRound.committeeStage">
                  <button v-if="historyRound.committeeStage === 'proposals'" class="secondary" @click="advanceCommitteeStage(historyRound, 'support')">Cerrar propuestas e iniciar apoyos</button>
                  <button v-if="historyRound.committeeStage === 'support'" class="secondary" @click="advanceCommitteeStage(historyRound, 'approval')">Cerrar apoyos e iniciar aprobación</button>
                  <button v-if="historyRound.committeeStage === 'approval'" class="secondary" @click="advanceCommitteeStage(historyRound, 'election')">Abrir etapa de elección</button>
                  <button v-if="historyRound.committeeStage === 'tie_break'" class="primary" @click="moderatorAction(`/moderator/rounds/${encodeURIComponent(historyRound.id)}/open`)">Abrir segunda votación secreta</button>
                </div>
              </template>
              <p v-if="historyRound.committeeStage === 'tie_break_required'" class="status-line">Empate en el último cupo: debe abrirse la nueva votación secreta registrada en la ronda vinculada.</p>
              <div v-if="historyRound.results?.length" class="results-list compact-results">
                <div v-for="result in historyRound.results" :key="result.optionId"><span>{{ result.label }}</span><strong>{{ result.count }}</strong></div>
              </div>
              <div v-if="historyRound.officialResult" class="declared-result">
                <strong>Declaración {{ historyRound.officialResult.publishedAt ? 'publicada' : 'interna' }}</strong>
                <p>Electos: {{ historyRound.officialResult.elected.map((person) => person.label).join(', ') }}</p>
                <p v-if="historyRound.officialResult.note">Observación: {{ historyRound.officialResult.note }}</p>
                <small>Registrada {{ formatDateTime(historyRound.officialResult.declaredAt) }} por {{ formatActor(historyRound.officialResult.declaredBy) }}</small>
              </div>
              <p v-else class="status-line">La mesa aún no ha registrado una declaración oficial.</p>
              <form v-if="historyRound.status === 'closed' || historyRound.status === 'published'" class="official-form" @submit.prevent="saveOfficialResult(historyRound)">
                <fieldset class="official-options"><legend>Persona(s) declarada(s) electa(s)</legend>
                  <label v-for="option in historyRound.options" :key="option.id"><input v-model="officialSelections[historyRound.id]" type="checkbox" :value="option.id" />{{ option.label }}</label>
                </fieldset>
                <label>Observación o motivo (opcional)<textarea v-model="officialNotes[historyRound.id]" rows="2" maxlength="1000" placeholder="Ej. Decisión de desempate de la Asamblea"></textarea></label>
                <div class="action-row">
                  <button class="secondary" :disabled="loading">{{ historyRound.officialResult ? 'Corregir declaración' : 'Registrar resultado oficial' }}</button>
                  <button v-if="historyRound.officialResult && !historyRound.officialResult.publishedAt && historyRound.status === 'published'" type="button" class="primary" :disabled="loading" @click="moderatorAction(`/moderator/rounds/${encodeURIComponent(historyRound.id)}/official-result/publish`)">Publicar declaración</button>
                  <span v-else-if="historyRound.officialResult?.publishedAt" class="status-line">Visible al público</span>
                </div>
              </form>
            </article>
          </section>
        </template>
      </template>
    </template>

    <template v-else>
      <div v-if="code" class="projector-controls"><span>Esta ventana es solo para el público. La moderación sigue en la ventana original. Muévela al televisor antes de proyectar.</span><button class="secondary" @click="toggleProjectorFullscreen">{{ projectorFullscreen ? 'Salir de pantalla completa' : 'Iniciar proyección' }}</button></div>
      <section v-if="!code" class="card join-card"><p class="eyebrow">PANTALLA PÚBLICA</p><h1>Proyector</h1><p class="lead">Ingresa el código de la sala para mostrar el estado permitido de la Asamblea.</p><form @submit.prevent="go(`/projector?code=${encodeURIComponent(code)}`)"><label>Código de sala<input v-model="code" required /></label><button class="primary">Mostrar sala</button></form></section>
      <section v-else class="projector-content">
        <p class="eyebrow">ASDMR · UNIÓN HONDUREÑA</p>
        <h1>{{ assemblyStatus === 'completed' ? 'Asamblea finalizada' : round?.status === 'published' ? 'Resultados publicados' : round?.status === 'open' || round?.status === 'closed' ? round.title : 'Sala de Asamblea' }}</h1>
        <p class="projector-subtitle">{{ assemblyStatus === 'completed' ? `Sesión concluida${completionTime ? ` · ${completionTime}` : ''}` : round?.status === 'open' ? 'Votación abierta' : round?.status === 'closed' ? 'Votación cerrada · resultados ocultos' : round?.status === 'published' ? 'Resultados autorizados por la mesa' : 'Estado: ' + assemblyStatus }}</p>
        <p v-if="realtimeActive && !realtimeConnected" class="connection-warning projector-connection-warning" role="status" aria-live="polite">Conexión interrumpida · Intentando reconectar. Los datos mostrados son los últimos confirmados.</p>
        <div v-if="round?.status === 'published'" class="results-list">
          <div v-for="result in state?.results || []" :key="result.label"><span>{{ result.label }}</span><strong>{{ result.count }} {{ result.count === 1 ? 'voto' : 'votos' }}</strong></div>
          <p class="projector-result-total">Total: {{ (state?.results || []).reduce((total, result) => total + result.count, 0) }} {{ (state?.results || []).reduce((total, result) => total + result.count, 0) === 1 ? 'voto' : 'votos' }}</p>
          <p class="projector-results-note">Conteo agregado por opción · sin proclamación automática de ganador</p>
        </div>
        <section v-if="state?.officialResult" class="projector-official-result"><p class="eyebrow">RESULTADO DECLARADO POR LA MESA</p><h2>{{ state.officialResult.elected.map((person) => person.label).join(' · ') }}</h2><p v-if="state.officialResult.note">{{ state.officialResult.note }}</p><small>Declaración registrada {{ formatDateTime(state.officialResult.declaredAt) }}</small></section>
        <div v-if="round?.status === 'open' || round?.status === 'closed'" class="projector-progress" aria-live="polite">
          <strong>{{ state?.recordedCount ?? 0 }}</strong>
          <span>de {{ state?.eligibleCount ?? state?.participantCount ?? 0 }} {{ (state?.eligibleCount ?? state?.participantCount ?? 0) === 1 ? 'voto recibido' : 'votos recibidos' }}</span>
          <div class="progress-track" role="progressbar" :aria-valuenow="state?.recordedCount ?? 0" :aria-valuemin="0" :aria-valuemax="state?.eligibleCount ?? state?.participantCount ?? 0" aria-label="Participación agregada en la votación"><span :style="{ width: `${projectorProgressPercent}%` }"></span></div>
          <p v-if="round?.status === 'closed'" class="projector-closed-note">La votación terminó. Los resultados se mostrarán cuando la mesa decida publicarlos.</p>
        </div>
        <div v-else-if="lobbyStatus !== 'lobby_open' && round?.status !== 'published'" class="projector-progress"><strong>{{ state?.participantCount ?? 0 }}</strong><span>personas en la sala</span></div>
        <section v-if="lobbyStatus === 'lobby_open'" class="projector-lobby" aria-label="Ingreso abierto">
          <div class="projector-lobby-summary">
            <img v-if="qrImage" class="projector-qr" :src="qrImage" alt="Código QR para unirse a la Asamblea" />
            <div><p class="eyebrow">INGRESO ABIERTO</p><strong class="projector-join-count">{{ state?.participantCount ?? 0 }}</strong><span>personas han ingresado</span><p>Código: <strong>{{ code }}</strong></p></div>
          </div>
          <div class="projector-participant-panel">
            <h2>Personas que ya ingresaron <span>{{ state?.participantCount ?? 0 }}</span></h2>
            <ul class="projector-participants" aria-label="Lista de participantes en la sala">
              <li v-for="(person, index) in state?.participants || []" :key="`${person.firstName}-${person.lastName}-${index}`">{{ person.firstName }} {{ person.lastName }}</li>
              <li v-if="!state?.participants?.length" class="empty">Todavía no ha ingresado nadie.</li>
            </ul>
            <p class="projector-list-note">Al iniciar la votación, esta lista se oculta y el proyector muestra solo el progreso agregado.</p>
          </div>
        </section>
      </section>
    </template>
  </main>
  <footer v-if="role !== 'projector'"><span>V1 · Herramienta operativa de la Asamblea</span><button class="link-button" @click="refresh">Sincronizar estado</button></footer>
</template>
