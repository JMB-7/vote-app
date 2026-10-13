<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { io, type Socket } from 'socket.io-client'

type PublicState = {
  assembly?: { id?: string; name?: string; status?: string; lobbyStatus?: string }
  status?: string
  lobbyStatus?: string
  participants?: Array<{ id: string; firstName: string; lastName: string }>
  participantCount?: number
  eligibleCount?: number
  participationStatus?: 'pending' | 'recorded'
  currentRound?: { id: string; title: string; status: string; options?: Array<{ id: string; label: string }> }
  results?: Array<{ label: string; count: number }>
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1'
const origin = window.location.origin
const route = ref(window.location.pathname)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const state = ref<PublicState | null>(null)
const urlParams = new URLSearchParams(window.location.search)
const code = ref(urlParams.get('join') || urlParams.get('code') || localStorage.getItem('assemblyJoinCode') || '')
const firstName = ref('')
const lastName = ref('')
const sessionToken = ref(localStorage.getItem('participantSessionToken') || '')
const moderatorToken = ref(sessionStorage.getItem('moderatorToken') || '')
const moderatorAuthState = ref<'unauthenticated' | 'validating' | 'authenticated' | 'validation_error'>(moderatorToken.value ? 'validating' : 'unauthenticated')
const moderatorCredential = ref('')
const assemblyId = ref(sessionStorage.getItem('assemblyId') || '')
const assemblyName = ref('Asamblea de Delegados')
const roundTitle = ref('')
const optionsText = ref('')
const selectedOption = ref('')
const reviewingVote = ref(false)
const voteSubmitting = ref(false)
const reviewHeading = ref<HTMLElement | null>(null)
const qrImage = ref('')
let refreshTimer: number | undefined
let realtimeSocket: Socket | null = null

const role = computed(() => route.value.startsWith('/moderator') ? 'moderator' : route.value.startsWith('/projector') ? 'projector' : 'participant')
const assemblyStatus = computed(() => state.value?.assembly?.status || state.value?.status || 'preparing')
const lobbyStatus = computed(() => state.value?.assembly?.lobbyStatus || (state.value?.lobbyStatus === 'open' || assemblyStatus.value === 'lobby_open' ? 'lobby_open' : 'lobby_closed'))
const round = computed(() => state.value?.currentRound)
const reviewedOption = computed(() => round.value?.options?.find((option) => option.id === selectedOption.value))

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

function normalizeState(value: Record<string, any>): PublicState {
  const rawRound = value.currentRound || value.openRound || value.round || value.rounds?.at(-1) || null
  const options = rawRound?.options?.map((option: any) => ({ id: option.id || option.optionId, label: option.label }))
  const currentRound = rawRound ? {
    id: rawRound.id || rawRound.roundId,
    title: rawRound.title,
    status: rawRound.status,
    ...(options ? { options } : {}),
  } : undefined
  const assembly = value.assembly || (value.assemblyStatus
    ? { status: value.assemblyStatus }
    : value.id ? { id: value.id, name: value.name, status: value.status } : undefined)
  return {
    ...value,
    assembly,
    lobbyStatus: value.lobbyStatus,
    currentRound,
    results: value.results || rawRound?.results,
    participants: value.participants,
    participantCount: value.participantCount,
    participationStatus: value.participationStatus,
    eligibleCount: value.eligibleCount,
  }
}

async function refresh() {
  if (loading.value) return
  if (role.value === 'participant' && sessionToken.value) {
    loading.value = true
    try {
      state.value = normalizeState(await request<Record<string, any>>('/participant/me', {}, sessionToken.value))
    } catch (e) {
      if ((e as Error).message.includes('401') || (e as Error).message.toLowerCase().includes('sesión')) {
        sessionToken.value = ''
        localStorage.removeItem('participantSessionToken')
      }
      error.value = (e as Error).message
    } finally { loading.value = false }
  } else if (role.value === 'projector' && code.value) {
    loading.value = true
    try { state.value = normalizeState(await request<Record<string, any>>(`/assemblies/${encodeURIComponent(code.value)}/public-state`)) }
    catch (e) { error.value = (e as Error).message }
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
    localStorage.setItem('participantSessionToken', joined.participantSessionToken)
    state.value = normalizeState(joined)
    notice.value = 'Te uniste a la sala. Tu teléfono queda en espera.'
    await refresh()
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}

function reviewVote() {
  if (!round.value || !selectedOption.value || !reviewedOption.value || loading.value || voteSubmitting.value) return
  error.value = ''
  notice.value = ''
  reviewingVote.value = true
}

async function submitVote() {
  if (!round.value || !selectedOption.value || !reviewedOption.value || !reviewingVote.value || loading.value || voteSubmitting.value) return
  error.value = ''
  notice.value = ''
  voteSubmitting.value = true
  loading.value = true
  let accepted = false
  try {
    await request(`/participant/rounds/${encodeURIComponent(round.value.id)}/vote`, {
      method: 'POST', body: JSON.stringify({ optionId: selectedOption.value, confirmation: true }),
    }, sessionToken.value)
    notice.value = 'Tu participación fue registrada. Gracias.'
    selectedOption.value = ''
    reviewingVote.value = false
    accepted = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false; voteSubmitting.value = false }
  if (accepted) await refresh()
}

async function moderatorAction(path: string, method = 'POST', body?: unknown) {
  if (!window.confirm('¿Confirmas esta acción de moderación?')) return
  error.value = ''
  loading.value = true
  let succeeded = false
  try {
    await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, moderatorToken.value)
    notice.value = 'Acción registrada.'
    succeeded = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
  if (succeeded) await refresh()
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

function editParticipant(person: { id: string; firstName: string; lastName: string }) {
  const updatedFirst = window.prompt('Corrige el nombre del participante:', person.firstName)
  if (updatedFirst === null) return
  const updatedLast = window.prompt('Corrige el apellido del participante:', person.lastName)
  if (updatedLast === null) return
  void moderatorAction(`/moderator/participants/${encodeURIComponent(person.id)}`, 'PATCH', {
    firstName: updatedFirst.trim(), lastName: updatedLast.trim(),
  })
}

async function createRound() {
  const options = optionsText.value.split('\n').map((label) => label.trim()).filter(Boolean)
  if (options.length < 2) { error.value = 'Agrega al menos dos opciones, una por línea.'; return }
  const apiOptions = options.map((label) => ({ label }))
  await moderatorAction(`/moderator/assemblies/${encodeURIComponent(assemblyId.value)}/rounds`, 'POST', {
    title: roundTitle.value, format: 'single_choice', options: apiOptions,
    countingRule: { kind: 'count_only', label: 'Conteo agregado por opción; sin proclamación automática' },
  })
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
  let auth: Record<string, string> | null = null
  if (role.value === 'participant' && sessionToken.value) auth = { audience: 'participant', participantSessionToken: sessionToken.value }
  else if (role.value === 'moderator' && moderatorToken.value && assemblyId.value) auth = { audience: 'moderator', moderatorCredential: moderatorToken.value, assemblyId: assemblyId.value }
  else if (role.value === 'projector' && code.value) auth = { audience: 'public', assemblyCode: code.value }
  if (!auth) return
  const socketUrl = import.meta.env.VITE_SOCKET_URL || `${API.replace(/\/api\/v1\/?$/, '')}/events`
  realtimeSocket = io(socketUrl, { auth, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelayMax: 5000 })
  for (const event of ['assembly.state', 'lobby.state', 'participant.joined', 'participant.updated', 'participant.removed', 'participant.state', 'round.state', 'round.opened', 'round.closed', 'participation.count', 'results.published']) {
    realtimeSocket.on(event, () => { void refresh() })
  }
  realtimeSocket.on('connect', () => { void refresh() })
}

onMounted(() => {
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
onUnmounted(() => { if (refreshTimer) window.clearInterval(refreshTimer); realtimeSocket?.disconnect() })
</script>

<template>
  <header class="topbar">
    <a class="brand" href="/" @click.prevent="go('/')"><span class="brand-mark">A</span><span>ASDMR <small>Unión Hondureña</small></span></a>
    <nav v-if="role === 'moderator'" aria-label="Vistas de mesa">
      <a href="/" @click.prevent="go('/')">Delegado</a>
      <a :href="`/projector${code ? `?code=${encodeURIComponent(code)}` : ''}`" @click.prevent="go('/projector')">Proyector</a>
    </nav>
  </header>

  <main :class="['page', { 'projector-page': role === 'projector' }]">
    <div v-if="error" class="notice error" role="alert"><strong>Ocurrió un problema.</strong> {{ error }}</div>
    <div v-if="notice" class="notice success" role="status">{{ notice }}</div>
    <p v-if="loading" class="sync" aria-live="polite">Actualizando estado…</p>

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
        <p class="eyebrow">{{ state?.assembly?.name || 'ASAMBLEA' }}</p>
        <h1>{{ round?.status === 'open' ? round.title : 'Sala de espera' }}</h1>
        <template v-if="state?.participationStatus === 'recorded'">
          <div class="status-panel"><span class="status-dot"></span><div><strong>Tu participación está registrada</strong><p>La papeleta fue confirmada y no puede cambiarse. No se muestra aquí la opción seleccionada.</p></div></div>
        </template>
        <template v-else-if="round?.status === 'open' && round.options?.length && reviewingVote">
          <section class="vote-review" aria-labelledby="vote-review-title">
            <p class="eyebrow">REVISIÓN DEL VOTO</p>
            <h2 id="vote-review-title" ref="reviewHeading" tabindex="-1">Confirma tu selección</h2>
            <dl class="review-details">
              <div><dt>Papeleta</dt><dd>{{ round.title }}</dd></div>
              <div><dt>Opción seleccionada</dt><dd>{{ reviewedOption?.label || 'La opción seleccionada ya no está disponible.' }}</dd></div>
            </dl>
            <p class="privacy-note">Después de confirmar, tu voto será definitivo y no podrás cambiarlo.</p>
            <div class="review-actions">
              <button class="secondary" :disabled="loading" @click="reviewingVote = false">Volver a la papeleta</button>
              <button class="primary" :disabled="loading || !reviewedOption" @click="submitVote">{{ voteSubmitting ? 'Enviando voto…' : 'Confirmar voto' }}</button>
            </div>
          </section>
        </template>
        <template v-else-if="round?.status === 'open' && round.options?.length">
          <p class="lead">Selecciona una opción, revísala y confirma cuando estés listo.</p>
          <fieldset class="options"><legend>Opciones de la papeleta</legend>
            <label v-for="option in round.options" :key="option.id" class="option"><input v-model="selectedOption" type="radio" name="option" :value="option.id" /><span>{{ option.label }}</span></label>
          </fieldset>
          <button class="primary" :disabled="loading || voteSubmitting || !selectedOption" @click="reviewVote">Revisar y confirmar voto</button>
          <p class="privacy-note">Tu selección es definitiva después de confirmarla.</p>
        </template>
        <div v-else class="status-panel"><span class="status-dot"></span><div><strong>{{ round?.status === 'closed' ? 'La papeleta está cerrada' : 'Esperando la siguiente papeleta' }}</strong><p>La mesa anunciará cuando comience la votación.</p></div></div>
      </section>
    </template>

    <template v-else-if="role === 'moderator'">
      <section v-if="moderatorAuthState === 'validating'" class="card join-card" aria-live="polite">
        <p class="eyebrow">ACCESO DE MESA</p><h1>Verificando acceso</h1>
        <p class="lead">Estamos validando la credencial con el servidor.</p>
      </section>
      <section v-else-if="moderatorAuthState === 'validation_error'" class="card join-card">
        <p class="eyebrow">ACCESO DE MESA</p><h1>No se pudo validar el acceso</h1>
        <p class="lead">La credencial se conserva. Comprueba la conexión e inténtalo de nuevo.</p>
        <button class="primary" :disabled="loading" @click="refresh">{{ loading ? 'Reintentando…' : 'Reintentar validación' }}</button>
      </section>
      <section v-else-if="moderatorAuthState !== 'authenticated'" class="card join-card">
        <p class="eyebrow">ACCESO DE MESA</p><h1>Moderación</h1>
        <p class="lead">Ingresa la credencial operativa autorizada por la organización.</p>
        <form @submit.prevent="signInModerator"><label>Credencial de moderación<input v-model="moderatorCredential" type="password" autocomplete="current-password" required /></label><button class="primary">Continuar</button></form>
      </section>
      <template v-else-if="moderatorAuthState === 'authenticated'">
        <section class="page-heading"><p class="eyebrow">PANEL DE MODERACIÓN</p><h1>Control de Asamblea</h1><p>El estado de la sesión y las votaciones proviene del servidor.</p></section>
        <section v-if="!assemblyId" class="card"><h2>Crear Asamblea</h2><form @submit.prevent="createAssembly"><label>Nombre<input v-model="assemblyName" required /></label><button class="primary" :disabled="loading">Crear Asamblea y generar código</button></form></section>
        <template v-else>
          <section class="summary-grid">
            <div class="card metric"><span>Estado</span><strong>{{ assemblyStatus }}</strong></div>
            <div class="card metric"><span>Participación</span><strong>{{ state?.participantCount ?? 0 }}<small v-if="state?.eligibleCount"> / {{ state.eligibleCount }}</small></strong></div>
            <div class="card metric"><span>Ingreso</span><strong>{{ lobbyStatus === 'lobby_open' ? 'Abierto' : 'Cerrado' }}</strong></div>
          </section>
          <section class="card"><div class="section-heading"><div><p class="eyebrow">INGRESO</p><h2>Participantes</h2></div><button class="secondary" @click="refresh">Actualizar lista</button></div>
            <ul class="participant-list"><li v-for="person in state?.participants || []" :key="person.id"><span>{{ person.firstName }} {{ person.lastName }}</span><span v-if="assemblyStatus === 'lobby_open' || assemblyStatus === 'lobby_closed'" class="person-actions"><button class="link-button" @click="editParticipant(person)">Corregir</button><button class="link-button remove-link" @click="moderatorAction(`/moderator/participants/${encodeURIComponent(person.id)}`, 'PATCH', { status: 'removed' })">Retirar</button></span></li><li v-if="!state?.participants?.length" class="empty">La lista aparecerá aquí cuando se unan.</li></ul>
            <div class="action-row"><button v-if="lobbyStatus === 'lobby_open'" class="secondary" :disabled="loading" @click="moderatorAction(`/moderator/assemblies/${assemblyId}/lobby`, 'PATCH', { status: 'lobby_closed' })">Cerrar ingreso</button><span v-else class="status-line">El ingreso está cerrado.</span><a v-if="code" class="text-link" :href="`/?join=${encodeURIComponent(code)}`">Código: {{ code }}</a></div>
            <div v-if="qrImage" class="qr-panel"><img :src="qrImage" alt="Código QR para unirse a la Asamblea" /><div><strong>Escanea para unirte</strong><p>Abre este enlace en el proyector y muestra el código QR durante el ingreso.</p><a :href="`/?code=${encodeURIComponent(code)}`">{{ origin }}/?code={{ code }}</a></div></div>
          </section>
          <section class="card"><p class="eyebrow">PAPELETA</p><h2>{{ round?.title || 'Preparar votación' }}</h2>
            <template v-if="!round || round.status === 'published' || round.status === 'closed'">
              <form @submit.prevent="createRound"><label>Título o cargo<input v-model="roundTitle" required placeholder="Ej. Elección de presidencia" /></label><label>Opciones o candidatos <span class="hint">Una por línea</span><textarea v-model="optionsText" rows="4" required placeholder="Nombre o descripción de cada opción"></textarea></label><button class="primary" :disabled="loading">Preparar papeleta</button></form>
            </template>
            <p v-if="round?.status === 'draft'" class="status-line">Papeleta preparada. Revisa las opciones antes de abrir.</p>
            <p v-if="round?.status === 'closed'" class="status-line">La papeleta está cerrada. Los resultados siguen ocultos hasta publicarlos.</p>
            <ul v-if="round?.options?.length" class="option-list"><li v-for="option in round.options" :key="option.id">{{ option.label }}</li></ul>
            <div class="action-row" v-if="round"><button v-if="round.status === 'draft'" class="primary" @click="moderatorAction(`/moderator/rounds/${round.id}/open`)">Abrir papeleta</button><button v-if="round.status === 'open'" class="danger" @click="moderatorAction(`/moderator/rounds/${round.id}/close`)">Cerrar papeleta</button><button v-if="round.status === 'closed'" class="primary" @click="moderatorAction(`/moderator/rounds/${round.id}/publish`)">Publicar resultados</button></div>
            <p class="privacy-note">Los resultados por opción permanecen ocultos hasta que el moderador los publique.</p>
          </section>
        </template>
      </template>
    </template>

    <template v-else>
      <section v-if="!code" class="card join-card"><p class="eyebrow">PANTALLA PÚBLICA</p><h1>Proyector</h1><p class="lead">Ingresa el código de la sala para mostrar el estado permitido de la Asamblea.</p><form @submit.prevent="go(`/projector?code=${encodeURIComponent(code)}`)"><label>Código de sala<input v-model="code" required /></label><button class="primary">Mostrar sala</button></form></section>
      <section v-else class="projector-content">
        <p class="eyebrow">ASDMR · UNIÓN HONDUREÑA</p>
        <h1>{{ round?.status === 'published' ? 'Resultados publicados' : round?.status === 'open' ? round.title : 'Sala de Asamblea' }}</h1>
        <p class="projector-subtitle">{{ round?.status === 'open' ? 'Votación abierta' : round?.status === 'published' ? 'Resultados autorizados por la mesa' : 'Estado: ' + assemblyStatus }}</p>
        <div v-if="round?.status === 'published'" class="results-list"><div v-for="result in state?.results || []" :key="result.label"><span>{{ result.label }}</span><strong>{{ result.count }}</strong></div></div>
        <div v-else class="projector-progress"><strong>{{ state?.participantCount ?? 0 }}</strong><span>participaciones registradas</span></div>
        <div v-if="lobbyStatus === 'lobby_open'" class="projector-lobby"><img v-if="qrImage" class="projector-qr" :src="qrImage" alt="Código QR para unirse a la Asamblea" /><div>Escanea el QR para unirte<p>Código: <strong>{{ code }}</strong></p></div></div>
      </section>
    </template>
  </main>
  <footer><span>V1 · Herramienta operativa de la Asamblea</span><button v-if="role !== 'projector'" class="link-button" @click="refresh">Sincronizar estado</button></footer>
</template>
