import { expect, test, type Page } from '@playwright/test'
import { appOrigin, bearer, createSite, issueKey, signIn } from './support'

const ownedKeyLabels = new WeakMap<Page, string>()

test.afterEach(async ({ page }) => {
  const label = ownedKeyLabels.get(page)
  if (!label) return
  const session = await (await page.request.get('/web/session')).json() as { authenticated: boolean; csrfToken: string }
  if (!session.authenticated) return
  const { keys } = await (await page.request.get('/web/keys')).json() as { keys: { id: string; label: string }[] }
  for (const key of keys.filter((key) => key.label === label)) {
    const response = await page.request.post(`/web/keys/${key.id}/revoke`, { headers: { origin: appOrigin }, data: { csrfToken: session.csrfToken } })
    expect(response.status(), await response.text()).toBe(200)
  }
})

async function issueOwnedKey(page: Page, label: string) {
  ownedKeyLabels.set(page, label)
  return issueKey(page, label)
}

async function openSite(page: Page, name: string) {
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test('owner inspects and restores retained files while keeping site settings', async ({ page }, testInfo) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `History ${Date.now()}`)
  const name = `History site ${Date.now()}`
  const created = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Original</h1>' },
    { path: 'notes.txt', content: 'older notes' },
  ])
  const updated = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: created.site.version,
    files: [{ path: 'index.html', content: '<h1>Updated</h1>' }],
  } })
  expect(updated.status(), await updated.text()).toBe(200)

  await openSite(page, name)
  const history = page.getByRole('region', { name: 'Revision history' })
  await expect(history.getByText('2 retained revisions')).toBeVisible()
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await expect(history.getByText('notes.txt')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: testInfo.outputPath('revision-history-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('revision-history-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await expect(history.getByText('notes.txt')).toBeVisible()
  const download = page.waitForEvent('download')
  await history.getByRole('link', { name: 'Download' }).last().click()
  expect(await (await download).failure()).toBeNull()
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm revision restore' })).toContainText('v1')
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByText('v3', { exact: true })).toBeVisible()
  const current = await page.request.get(`/api/sites/${created.site.id}/file?path=index.html`, { headers: bearer(key) })
  expect(await current.text()).toBe('<h1>Original</h1>')
  const detail = await (await page.request.get(`/api/sites/${created.site.id}`, { headers: bearer(key) })).json()
  expect(detail.visibility).toBe('private')
  await expect(history.getByText('2 retained revisions')).toBeVisible()
  await expect(history.getByRole('button', { name: /v1 .*Current/ })).toBeVisible()
})

test('restore retries the exact command after a lost response', async ({ page }) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `Restore retry ${Date.now()}`)
  const name = `Restore retry site ${Date.now()}`
  const created = await createSite(page.request, key, name, [{ path: 'index.html', content: 'first' }])
  const updated = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', content: 'second' }],
  } })
  expect(updated.status(), await updated.text()).toBe(200)
  await openSite(page, name)
  const history = page.getByRole('region', { name: 'Revision history' })
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  const commands: unknown[] = []
  await page.route(`**/web/sites/${created.site.id}/restore`, async (route) => {
    commands.push(route.request().postDataJSON())
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (commands.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm revision restore' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Confirm revision restore' }).getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByText('v3', { exact: true })).toBeVisible()
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
})

test('restore conflict refreshes history and requires a second confirmation', async ({ page }) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `Restore conflict ${Date.now()}`)
  const name = `Restore conflict site ${Date.now()}`
  const created = await createSite(page.request, key, name, [{ path: 'index.html', content: 'first' }])
  const updated = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', content: 'second' }],
  } })
  expect(updated.status(), await updated.text()).toBe(200)
  await openSite(page, name)
  const history = page.getByRole('region', { name: 'Revision history' })
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  const changed = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 2, files: [{ path: 'index.html', content: 'third' }],
  } })
  expect(changed.status(), await changed.text()).toBe(200)
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm revision restore' })).toHaveCount(0)
  await expect(history.getByText('This site changed. Review its current version and confirm restore again.')).toBeVisible()
  await expect(page.getByText('v3', { exact: true })).toBeVisible()
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByText('v4', { exact: true })).toBeVisible()
})

test('a dirty editor draft must be saved or discarded before restore', async ({ page }) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `Restore draft ${Date.now()}`)
  const name = `Restore draft site ${Date.now()}`
  const created = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>first</h1>' }, { path: 'notes.txt', content: 'first notes' },
  ])
  const updated = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', content: '<h1>second</h1>' }],
  } })
  expect(updated.status(), await updated.text()).toBe(200)
  await openSite(page, name)
  await page.getByRole('button', { name: 'Open file editor' }).click()
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await workspace.getByRole('button').filter({ hasText: 'notes.txt' }).click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  await workspace.locator('.cm-content[contenteditable=true]').fill('unsaved owner draft')
  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  const guard = page.getByRole('dialog', { name: 'Leave unsaved changes' })
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.getByRole('region', { name: 'Revision history' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  await guard.getByRole('button', { name: 'Discard and leave' }).click()
  const history = page.getByRole('region', { name: 'Revision history' })
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByText('v3', { exact: true })).toBeVisible()
})

test('a late file page stays with its original revision', async ({ page }) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `History paging ${Date.now()}`)
  const name = `History paging site ${Date.now()}`
  const initial = [
    { path: 'index.html', content: 'original' },
    ...Array.from({ length: 99 }, (_, index) => ({ path: `assets/file-${String(index).padStart(3, '0')}.txt`, content: `${index}` })),
  ]
  const created = await createSite(page.request, key, name, initial)
  const response = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'z-extra.txt', content: 'new revision only' }],
  } })
  expect(response.status(), await response.text()).toBe(200)
  await openSite(page, name)
  const history = page.getByRole('region', { name: 'Revision history' })
  await history.getByRole('button', { name: /v2 .*Current/ }).click()
  const more = history.getByRole('button', { name: 'Load more files' })
  await expect(more).toBeVisible()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let captured!: () => void
  const ready = new Promise<void>((resolve) => { captured = resolve })
  await page.route(`**/web/sites/${created.site.id}/files?**`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue()
    const result = await route.fetch()
    captured()
    await held
    await route.fulfill({ response: result })
  })
  await more.click()
  await ready
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await expect(history.getByText(/^100 files ·/)).toBeVisible()
  release()
  await expect(history.getByText('z-extra.txt')).toHaveCount(0)
  await expect(history.getByRole('button', { name: 'Load more files' })).toHaveCount(0)
})

test('a completed restore reports a failed refresh without losing the result', async ({ page }) => {
  await signIn(page)
  const key = await issueOwnedKey(page, `Restore refresh ${Date.now()}`)
  const name = `Restore refresh site ${Date.now()}`
  const created = await createSite(page.request, key, name, [{ path: 'index.html', content: 'first' }])
  const updated = await page.request.put(`/api/sites/${created.site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', content: 'second' }],
  } })
  expect(updated.status(), await updated.text()).toBe(200)
  await openSite(page, name)
  const history = page.getByRole('region', { name: 'Revision history' })
  await history.getByRole('button', { name: /v1 .*Published/ }).click()
  await history.getByRole('button', { name: 'Restore this revision' }).click()
  let failRefresh = true
  await page.route(`**/web/sites/${created.site.id}/revisions`, async (route) => {
    if (failRefresh) await route.fulfill({ status: 503, body: '{}' })
    else await route.continue()
  })
  await page.getByRole('button', { name: 'Confirm restore' }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm revision restore' })).toHaveCount(0)
  await expect(history.getByRole('alert')).toBeVisible()
  failRefresh = false
  await history.getByRole('button', { name: 'Refresh history' }).click()
  await expect(history.getByRole('button', { name: /v1 .*Current/ })).toBeVisible()
  expect((await (await page.request.get(`/api/sites/${created.site.id}`, { headers: bearer(key) })).json()).version).toBe(3)
})
