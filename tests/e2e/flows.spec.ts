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
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Cerrar papeleta' }).click()
  await expect(page.getByText('Acción registrada.')).toBeVisible()
  await page.getByRole('button', { name: 'Sincronizar estado' }).click()
  await expect(page.getByText('La papeleta está cerrada.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publicar resultados' })).toBeVisible()
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
  await expect(page.getByText('42', { exact: true })).toBeVisible()
  await expect(page.getByText('Delegado Sintético')).toHaveCount(0)
  await expect(page.getByText('Opción Alfa (prueba)')).toHaveCount(0)
})
