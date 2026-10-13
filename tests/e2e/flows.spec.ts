import { expect, test } from '@playwright/test'

const api = '**/api/v1/**'

function participantState(participationStatus: 'pending' | 'recorded' = 'pending') {
  return {
    assembly: { id: 'synthetic-assembly', name: 'Asamblea de prueba', status: 'in_progress', lobbyStatus: 'lobby_closed' },
    participationStatus,
    currentRound: {
      id: 'synthetic-round',
      title: 'Elección de prueba',
      status: 'open',
      options: [
        { id: 'synthetic-option-a', label: 'Opción Alfa (prueba)' },
        { id: 'synthetic-option-b', label: 'Opción Beta (prueba)' },
      ],
    },
  }
}

test('delegado ingresa con datos sintéticos y confirma su participación', async ({ page }) => {
  let voteCount = 0
  let releaseVote: (() => void) | undefined
  let markVoteStarted: (() => void) | undefined
  const votePending = new Promise<void>((resolve) => { releaseVote = resolve })
  const voteStarted = new Promise<void>((resolve) => { markVoteStarted = resolve })
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/assemblies/DEMO-ROOM/join')) {
      await route.fulfill({ json: { participantSessionToken: 'synthetic-participant-token', ...participantState() } })
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: participantState(voteCount ? 'recorded' : 'pending') })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/participant/rounds/synthetic-round/vote')) {
      voteCount += 1
      markVoteStarted?.()
      await votePending
      await route.fulfill({ status: 201, json: { status: 'recorded' } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/')
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Moderación' })).toHaveCount(0)
  await page.getByLabel('Código de sala').fill('DEMO-ROOM')
  await page.getByLabel('Nombre').fill('Delegado')
  await page.getByLabel('Apellido').fill('Sintético')
  await page.getByRole('button', { name: 'Unirme a la sala' }).click()
  await expect(page.getByText('Tu teléfono queda en espera.')).toBeVisible()

  await page.getByLabel('Opción Alfa (prueba)').check()
  await page.getByRole('button', { name: 'Revisar y confirmar voto' }).click()
  await expect(page.getByRole('heading', { name: 'Confirma tu selección' })).toBeFocused()
  await expect(page.locator('.review-details').getByText('Elección de prueba', { exact: true })).toBeVisible()
  await expect(page.locator('.review-details').getByText('Opción Alfa (prueba)', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Volver a la papeleta' }).click()
  await expect(page.getByLabel('Opción Alfa (prueba)')).toBeChecked()
  expect(voteCount).toBe(0)

  await page.getByLabel('Opción Beta (prueba)').check()
  await page.getByRole('button', { name: 'Revisar y confirmar voto' }).click()
  await expect(page.locator('.review-details').getByText('Opción Beta (prueba)', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Confirmar voto' }).click()
  await voteStarted
  await expect(page.getByRole('button', { name: 'Enviando voto…' })).toBeDisabled()
  expect(voteCount).toBe(1)
  releaseVote?.()

  await expect(page.getByText('Tu participación fue registrada. Gracias.')).toBeVisible()
  await page.getByRole('button', { name: 'Sincronizar estado' }).click()
  await expect(page.getByText('Tu participación está registrada')).toBeVisible()
  expect(voteCount).toBe(1)
})

test('delegado vota en comisión con selección múltiple limitada a los cupos', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('participantSessionToken', 'committee-session'))
  let recorded = false
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: {
        assembly: { id: 'committee-assembly', name: 'Asamblea prueba', status: 'in_progress' },
        participationStatus: recorded ? 'recorded' : 'pending',
        currentRound: { id: 'committee-round', title: 'Comisión de Finanzas', status: 'open', format: 'multiple_choice', category: 'committee', committeeType: 'finance', memberCount: 2, options: [
          { id: 'candidate-a', label: 'Ana (prueba)' }, { id: 'candidate-b', label: 'Beto (prueba)' }, { id: 'candidate-c', label: 'Celia (prueba)' },
        ] },
      } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/participant/rounds/committee-round/vote')) {
      expect(request.postDataJSON()).toEqual({ optionIds: ['candidate-a', 'candidate-b'], confirmation: true })
      recorded = true
      await route.fulfill({ status: 201, json: { status: 'recorded' } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for secret committee ballot test' } })
  })

  await page.goto('/')
  await expect(page.getByLabel('Ana (prueba)')).toBeVisible()
  await page.getByLabel('Ana (prueba)').check()
  await page.getByLabel('Beto (prueba)').check()
  await page.getByLabel('Celia (prueba)').check()
  await expect(page.getByRole('alert')).toContainText('máximo 2 integrantes')
  await page.getByLabel('Celia (prueba)').uncheck()
  await page.getByRole('button', { name: 'Revisar y confirmar voto' }).click()
  await expect(page.locator('.review-details')).toContainText('Ana (prueba), Beto (prueba)')
  await page.getByRole('button', { name: 'Confirmar voto' }).click()
  await expect(page.getByText('Tu participación está registrada')).toBeVisible()
})

test('delegado registra una propuesta y apoyo sin mostrar identidades de apoyo', async ({ page }) => {
  let stage: 'proposals' | 'support' = 'proposals'
  let supported = false
  const stateForDelegate = () => ({
    assembly: { id: 'committee-assembly', name: 'Asamblea prueba', status: 'in_progress' },
    participationStatus: 'pending',
    currentRound: { id: 'nomination-round', title: 'Comisión de Nombramiento', status: 'draft', format: 'multiple_choice', category: 'committee', committeeType: 'nomination', committeeStage: stage, options: [] },
    committeeCandidates: [{ id: 'candidate-1', firstName: 'Ana', lastName: 'Delegada' }],
    committeeProposals: [{ id: 'proposal-1', candidateName: 'Ana Delegada', supportCount: supported ? 1 : 0, supportedByMe: supported }],
  })
  await page.addInitScript(() => localStorage.setItem('participantSessionToken', 'committee-session'))
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: stateForDelegate() }); return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/committee/proposals')) {
      expect(request.postDataJSON()).toEqual({ candidateParticipantId: 'candidate-1' })
      await route.fulfill({ status: 201, json: { id: 'proposal-1' } }); return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/committee/proposals/proposal-1/support')) {
      supported = true
      await route.fulfill({ status: 201, json: { status: 'supported' } }); return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for committee proposal test' } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Registrar propuesta' })).toBeVisible()
  await page.getByLabel('Candidatura').selectOption('candidate-1')
  await page.getByRole('button', { name: 'Registrar propuesta' }).click()
  stage = 'support'
  await page.getByRole('button', { name: 'Sincronizar estado' }).click()
  await expect(page.getByRole('heading', { name: 'Apoyar propuestas' })).toBeVisible()
  await expect(page.getByText('0 apoyos')).toBeVisible()
  await page.getByRole('button', { name: 'Apoyar' }).click()
  await expect(page.getByRole('button', { name: 'Apoyo registrado' })).toBeDisabled()
  await expect(page.getByText(/Solo se muestra el total, no quién apoyó/)).toBeVisible()
})

test('delegado conserva la sesión al recargar y puede salir limpiando el estado local', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('participantSessionToken', 'synthetic-session-token')
    localStorage.setItem('participantAssemblyId', 'assembly-a')
  })
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: { ...participantState(), assembly: { id: 'assembly-a', name: 'Asamblea A', status: 'in_progress' } } })
      return
    }
    if (route.request().method() === 'GET' && url.pathname.endsWith('/assemblies/CODE-A/public-state')) {
      await route.fulfill({ json: { assembly: { id: 'assembly-a', name: 'Asamblea A' } } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for participant session test' } })
  })

  await page.goto('/?join=CODE-A')
  await expect(page.getByText('Asamblea A')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Asamblea A')).toBeVisible()
  await page.getByRole('button', { name: 'Salir / cambiar de participante' }).click()
  await expect(page.getByRole('heading', { name: 'Bienvenido' })).toBeVisible()
  await expect(page.getByLabel('Código de sala')).toHaveValue('CODE-A')
  expect(await page.evaluate(() => localStorage.getItem('participantSessionToken'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('participantAssemblyId'))).toBeNull()
})

test('un 401 Unauthorized limpia la sesión y devuelve al ingreso del delegado', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('participantSessionToken', 'revoked-session-token')
    localStorage.setItem('participantAssemblyId', 'assembly-a')
  })
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ status: 401, json: { message: 'Unauthorized' } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'Not found' } })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Bienvenido' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Vuelve a ingresar mientras el ingreso a la asamblea esté abierto')
  expect(await page.evaluate(() => localStorage.getItem('participantSessionToken'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('participantAssemblyId'))).toBeNull()
})

test('un error temporal al cargar la sesión conserva la credencial del delegado', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('participantSessionToken', 'valid-session-token'))
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ status: 503, json: { message: 'Servicio temporalmente no disponible' } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'Not found' } })
  })

  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Servicio temporalmente no disponible')
  expect(await page.evaluate(() => localStorage.getItem('participantSessionToken'))).toBe('valid-session-token')
})

test('delegado debe confirmar el cambio cuando abre un QR de otra Asamblea', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('participantSessionToken', 'old-session-token')
    localStorage.setItem('participantAssemblyId', 'assembly-a')
  })
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      const assemblyId = request.headers()['authorization'] === 'Bearer new-session-token' ? 'assembly-b' : 'assembly-a'
      await route.fulfill({ json: { ...participantState(), assembly: { id: assemblyId, name: `Asamblea ${assemblyId === 'assembly-a' ? 'A' : 'B'}`, status: 'in_progress' } } })
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/assemblies/CODE-B/public-state')) {
      await route.fulfill({ json: { assembly: { id: 'assembly-b', name: 'Asamblea B' } } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/assemblies/CODE-B/join')) {
      await route.fulfill({ json: { participantSessionToken: 'new-session-token', ...participantState(), assembly: { id: 'assembly-b', name: 'Asamblea B', status: 'in_progress' } } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for QR switch test' } })
  })

  await page.goto('/?join=CODE-B')
  await expect(page.getByRole('alert')).toContainText('Este QR corresponde a otra Asamblea')
  await expect(page.getByText('Asamblea A')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cerrar sesión y cambiar a la Asamblea del QR' }).click()
  await expect(page.getByRole('heading', { name: 'Bienvenido' })).toBeVisible()
  await expect(page.getByLabel('Código de sala')).toHaveValue('CODE-B')
  expect(await page.evaluate(() => localStorage.getItem('participantSessionToken'))).toBeNull()

  await page.getByLabel('Nombre').fill('Nuevo')
  await page.getByLabel('Apellido').fill('Delegado')
  await page.getByRole('button', { name: 'Unirme a la sala' }).click()
  await expect(page.getByText('Te uniste a la sala. Tu teléfono queda en espera.')).toBeVisible()
  await expect(page.getByText('Asamblea B')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('participantSessionToken'))).toBe('new-session-token')
})

test('un error de red conserva la selección y permite revisar y reintentar', async ({ page }) => {
  let voteCount = 0
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/assemblies/DEMO-ROOM/join')) {
      await route.fulfill({ json: { participantSessionToken: 'synthetic-participant-token', ...participantState() } })
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: participantState(voteCount ? 'recorded' : 'pending') })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/participant/rounds/synthetic-round/vote')) {
      voteCount += 1
      if (voteCount === 1) {
        await route.fulfill({ status: 503, json: { message: 'Conexión temporalmente no disponible' } })
      } else {
        await route.fulfill({ status: 201, json: { status: 'recorded' } })
      }
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/')
  await page.getByLabel('Código de sala').fill('DEMO-ROOM')
  await page.getByLabel('Nombre').fill('Delegado')
  await page.getByLabel('Apellido').fill('Sintético')
  await page.getByRole('button', { name: 'Unirme a la sala' }).click()
  await page.getByLabel('Opción Beta (prueba)').check()
  await page.getByRole('button', { name: 'Revisar y confirmar voto' }).click()
  await page.getByRole('button', { name: 'Confirmar voto' }).click()

  await expect(page.getByRole('alert')).toContainText('Conexión temporalmente no disponible')
  await expect(page.locator('.review-details').getByText('Opción Beta (prueba)', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Volver a la papeleta' }).click()
  await expect(page.getByLabel('Opción Beta (prueba)')).toBeChecked()
  await page.getByRole('button', { name: 'Revisar y confirmar voto' }).click()
  await expect(page.locator('.review-details').getByText('Elección de prueba', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Confirmar voto' }).click()

  await expect(page.getByText('Tu participación fue registrada. Gracias.')).toBeVisible()
  expect(voteCount).toBe(2)
})

test('moderador ejecuta el cierre de una papeleta mediante acción confirmada', async ({ page }) => {
  let closed = false
  await page.addInitScript(() => {
    sessionStorage.setItem('moderatorToken', 'synthetic-moderator-token')
    sessionStorage.setItem('assemblyId', 'synthetic-assembly')
  })
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/moderator/assemblies/synthetic-assembly')) {
      await route.fulfill({ json: {
        assembly: { id: 'synthetic-assembly', name: 'Asamblea de prueba', status: 'in_progress', lobbyStatus: 'lobby_closed' },
        participants: [{ id: 'synthetic-person', firstName: 'Delegado', lastName: 'Sintético' }],
        participantCount: 1,
        eligibleCount: 1,
        currentRound: { id: 'synthetic-round', title: 'Elección de prueba', status: closed ? 'closed' : 'open', options: [{ id: 'a', label: 'Opción Alfa (prueba)' }, { id: 'b', label: 'Opción Beta (prueba)' }] },
      } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/moderator/rounds/synthetic-round/close')) {
      closed = true
      await route.fulfill({ status: 201, json: { status: 'closed' } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/moderator')
  await expect(page.getByRole('heading', { name: 'Control de Asamblea' })).toBeVisible()
  await expect(page.getByText('Delegado Sintético')).toBeVisible()
  await page.getByRole('button', { name: 'Cerrar votación' }).click()
  await expect(page.getByRole('dialog')).toContainText('Los resultados seguirán ocultos')
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar votación' }).click()
  await expect(page.getByText('Acción registrada.')).toBeVisible()
  await page.getByRole('button', { name: 'Sincronizar estado' }).click()
  await expect(page.getByText('La papeleta está cerrada.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publicar resultados' })).toBeVisible()
})

test('moderador declara el resultado oficial por separado y lo publica explícitamente', async ({ page }) => {
  let officialResult: Record<string, unknown> | null = null
  let publishCount = 0
  await page.addInitScript(() => {
    sessionStorage.setItem('moderatorToken', 'synthetic-moderator-token')
    sessionStorage.setItem('assemblyId', 'synthetic-assembly')
  })
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/moderator/assemblies/synthetic-assembly')) {
      await route.fulfill({ json: {
        id: 'synthetic-assembly', name: 'Asamblea de prueba', status: 'in_progress',
        rounds: [{
          id: 'synthetic-round', title: 'Elección de prueba', status: 'published',
          options: [{ id: 'a', label: 'Candidata Alfa' }, { id: 'b', label: 'Candidato Beta' }],
          results: [{ optionId: 'a', label: 'Candidata Alfa', count: 2 }, { optionId: 'b', label: 'Candidato Beta', count: 1 }],
          officialResult,
        }],
      } })
      return
    }
    if (request.method() === 'PUT' && url.pathname.endsWith('/moderator/rounds/synthetic-round/official-result')) {
      expect(request.postDataJSON()).toEqual({ optionIds: ['b'], note: 'Decisión de la Asamblea' })
      officialResult = {
        elected: [{ optionId: 'b', label: 'Candidato Beta' }], note: 'Decisión de la Asamblea',
        declaredBy: 'shared_moderator_credential', declaredAt: '2026-10-13T10:00:00.000Z', publishedAt: null,
      }
      await route.fulfill({ status: 200, json: officialResult })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/moderator/rounds/synthetic-round/official-result/publish')) {
      publishCount += 1
      officialResult = { ...officialResult, publishedAt: '2026-10-13T10:05:00.000Z' }
      await route.fulfill({ status: 200, json: officialResult })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for official result test' } })
  })

  await page.goto('/moderator')
  await expect(page.getByRole('heading', { name: 'Declaraciones oficiales de la mesa' })).toBeVisible()
  await expect(page.getByText('La mesa aún no ha registrado una declaración oficial.')).toBeVisible()
  await page.getByLabel('Candidato Beta').check()
  await page.getByLabel('Observación o motivo (opcional)').fill('Decisión de la Asamblea')
  await page.getByRole('button', { name: 'Registrar resultado oficial' }).click()
  await expect(page.getByRole('dialog')).toContainText('¿Guardar los cambios?')
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar cambios' }).click()
  await expect(page.getByText('Declaración interna')).toBeVisible()
  await expect(page.getByText('Decisión de la Asamblea')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publicar declaración' })).toBeVisible()
  expect(publishCount).toBe(0)

  await page.getByRole('button', { name: 'Publicar declaración' }).click()
  await expect(page.getByRole('dialog')).toContainText('¿Publicar resultados?')
  await page.getByRole('dialog').getByRole('button', { name: 'Publicar resultados' }).click()
  await expect(page.getByText('Visible al público')).toBeVisible()
  expect(publishCount).toBe(1)
})

test('moderador finaliza la Asamblea explícitamente y el panel queda en modo de consulta', async ({ page }) => {
  let roundClosed = false
  let assemblyCompleted = false
  const completedAt = '2026-10-02T18:30:00.000Z'
  await page.addInitScript(() => {
    sessionStorage.setItem('moderatorToken', 'synthetic-moderator-token')
    sessionStorage.setItem('assemblyId', 'synthetic-assembly')
  })
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/moderator/assemblies/synthetic-assembly')) {
      await route.fulfill({ json: {
        id: 'synthetic-assembly',
        name: 'Asamblea de prueba',
        status: assemblyCompleted ? 'completed' : 'in_progress',
        completedAt: assemblyCompleted ? completedAt : null,
        participants: [{ id: 'synthetic-person', firstName: 'Delegado', lastName: 'Sintético' }],
        participantCount: 1,
        eligibleCount: 1,
        rounds: [{ id: 'synthetic-round', title: 'Elección de prueba', status: roundClosed ? 'closed' : 'open', options: [{ id: 'a', label: 'Opción Alfa (prueba)' }] }],
      } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/moderator/rounds/synthetic-round/close')) {
      roundClosed = true
      await route.fulfill({ status: 201, json: { status: 'closed' } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/moderator/assemblies/synthetic-assembly/complete')) {
      expect(request.postDataJSON()).toEqual({ confirmation: true })
      assemblyCompleted = true
      await route.fulfill({ status: 201, json: { status: 'completed', completedAt } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/moderator')
  await expect(page.getByRole('heading', { name: 'Control de Asamblea' })).toBeVisible()
  await expect(page.getByText('Cierra la papeleta abierta antes de finalizar la Asamblea.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finalizar Asamblea' })).toBeDisabled()

  await page.getByRole('button', { name: 'Cerrar votación' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar votación' }).click()
  await expect(page.getByText('Acción registrada.')).toBeVisible()
  await page.getByRole('button', { name: 'Sincronizar estado' }).click()
  await expect(page.getByRole('button', { name: 'Finalizar Asamblea' })).toBeEnabled()

  await page.getByRole('button', { name: 'Finalizar Asamblea' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Finalizar Asamblea' }).click()
  await expect(page.getByText('La Asamblea quedó finalizada y disponible en modo de consulta.')).toBeVisible()
  await expect(page.getByText('Asamblea finalizada', { exact: true })).toBeVisible()
  await expect(page.getByText(/Se registró/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finalizar Asamblea' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Preparar papeleta' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Publicar resultados' })).toHaveCount(0)
})

test('delegado y proyector ven que la Asamblea concluyó y conservan resultados publicados', async ({ page }) => {
  const completedAt = '2026-10-02T18:30:00.000Z'
  await page.addInitScript(() => {
    localStorage.setItem('participantSessionToken', 'synthetic-participant-token')
    localStorage.setItem('assemblyJoinCode', 'DEMO-ROOM')
  })
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/participant/me')) {
      await route.fulfill({ json: {
        assemblyStatus: 'completed',
        assemblyCompletedAt: completedAt,
        lobbyStatus: 'closed',
        openRound: { roundId: 'synthetic-round', title: 'Elección publicada', status: 'published', options: [] },
        participationStatus: 'recorded',
        results: [{ label: 'Opción declarada', count: 1 }],
      } })
      return
    }
    if (url.pathname.endsWith('/assemblies/DEMO-ROOM/public-state')) {
      await route.fulfill({ json: {
        assembly: { name: 'Asamblea de prueba', status: 'completed', completedAt, lobbyStatus: 'lobby_closed' },
        participantCount: 1,
        currentRound: { id: 'synthetic-round', title: 'Elección publicada', status: 'published' },
        results: [{ label: 'Opción declarada', count: 1 }],
      } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Asamblea finalizada' })).toBeVisible()
  await expect(page.getByText('La sesión concluyó')).toBeVisible()
  await expect(page.getByText('Tu participación está registrada')).toBeVisible()

  await page.goto('/projector?code=DEMO-ROOM')
  await expect(page.getByRole('heading', { name: 'Asamblea finalizada' })).toBeVisible()
  await expect(page.getByText('Opción declarada')).toBeVisible()
})

test('moderador con credencial caducada vuelve a mostrar acceso y elimina el token guardado', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('moderatorToken', 'stale-moderator-token')
    sessionStorage.setItem('assemblyId', 'synthetic-assembly')
  })
  await page.route(api, async (route) => {
    await route.fulfill({ status: 401, json: { message: 'Unauthorized' } })
  })

  await page.goto('/moderator')
  await expect(page.getByLabel('Credencial de moderación')).toBeVisible()
  await expect(page.getByText('La credencial guardada ya no es válida. Ingresa de nuevo la clave de moderación.')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('moderatorToken'))).toBeNull()
})

test('abrir /moderator sin credencial solo muestra el formulario de acceso', async ({ page }) => {
  let moderatorRequests = 0
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/moderator/')) moderatorRequests += 1
    await route.fulfill({ status: 401, json: { message: 'Unauthorized' } })
  })

  await page.goto('/moderator')
  await expect(page.getByRole('heading', { name: 'Moderación' })).toBeVisible()
  await expect(page.getByLabel('Credencial de moderación')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Control de Asamblea' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Crear Asamblea y generar código' })).toHaveCount(0)
  expect(moderatorRequests).toBe(0)
})

test('moderador valida la credencial antes de mostrar el panel cuando aún no hay Asamblea', async ({ page }) => {
  let authorization = ''
  await page.route(api, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/moderator/session')) {
      authorization = request.headers().authorization || ''
      await route.fulfill({ json: { authenticated: true } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/moderator')
  await page.getByLabel('Credencial de moderación').fill('synthetic-moderator-token')
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByRole('heading', { name: 'Control de Asamblea' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Crear Asamblea' })).toBeVisible()
  expect(authorization).toBe('Bearer synthetic-moderator-token')
})

test('error temporal al validar conserva la credencial guardada y permite reintentar', async ({ page }) => {
  let validationAttempts = 0
  await page.addInitScript(() => {
    sessionStorage.setItem('moderatorToken', 'saved-moderator-token')
  })
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/moderator/session')) {
      validationAttempts += 1
      if (validationAttempts === 1) {
        await route.fulfill({ status: 503, json: { message: 'Servicio temporalmente no disponible' } })
      } else {
        await route.fulfill({ json: { authenticated: true } })
      }
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/moderator')
  await expect(page.getByRole('heading', { name: 'No se pudo validar el acceso' })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('moderatorToken'))).toBe('saved-moderator-token')
  await page.getByRole('button', { name: 'Reintentar validación' }).click()
  await expect(page.getByRole('heading', { name: 'Control de Asamblea' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(validationAttempts).toBe(2)
  expect(await page.evaluate(() => sessionStorage.getItem('moderatorToken'))).toBe('saved-moderator-token')
})

test('proyector presenta estado y progreso sintético sin nombres ni opciones', async ({ page }) => {
  await page.route(api, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/assemblies/DEMO-ROOM/public-state')) {
      await route.fulfill({ json: {
        assembly: { name: 'Asamblea de prueba', status: 'in_progress', lobbyStatus: 'lobby_closed' },
        participantCount: 42,
        currentRound: { id: 'synthetic-round', title: 'Elección de prueba', status: 'open' },
      } })
      return
    }
    await route.fulfill({ status: 404, json: { message: 'No mock route for synthetic UI test' } })
  })

  await page.goto('/projector?code=DEMO-ROOM')
  await expect(page.getByRole('heading', { name: 'Elección de prueba' })).toBeVisible()
  await expect(page.getByText('Votación abierta')).toBeVisible()
  await expect(page.getByText('de 42 votos recibidos')).toBeVisible()
  await expect(page.getByText('Delegado Sintético')).toHaveCount(0)
  await expect(page.getByText('Opción Alfa (prueba)')).toHaveCount(0)
})
