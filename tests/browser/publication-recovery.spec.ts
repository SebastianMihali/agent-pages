import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function existingSite(page: Page, suffix: string) {
  await signIn(page)
  const label = `Publication recovery ${crypto.randomUUID()}`
  ownedKeyLabels.set(page, label)
  const key = await issueKey(page, label)
  const { site } = await createSite(page.request, key, `Recovery ${suffix}`, [
    { path: 'index.html', content: '<h1>Original page</h1>' }, { path: 'notes.txt', content: 'Original notes\n' },
  ])
  await page.goto(`/?site=${site.id}`)
  await expect(page.getByRole('region', { name: 'Site files' })).toBeVisible()
  return { site, key }
}

async function version(page: Page, key: string, siteId: string) {
  const response = await page.request.get(`/api/sites/${siteId}`, { headers: bearer(key) })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()).version as number
}

test('cancelling during the authentication preflight sends no publication and preserves the revision', async ({ page }) => {
  const { site, key } = await existingSite(page, 'cancel')
  await page.getByLabel('Upload files', { exact: true }).setInputFiles({ name: 'cancelled.txt', mimeType: 'text/plain', buffer: Buffer.from('not published') })
  const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
  await expect(dialog.getByRole('button', { name: 'Publish files', exact: true })).toBeEnabled()

  // Hold the real authentication preflight before any upload starts. This proves
  // cancellation before sending, not rollback after a completed body transfer.
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const preflightEntered = new Promise<void>((resolve) => { entered = resolve })
  let publications = 0
  page.on('request', (request) => { if (request.method() === 'PUT' && request.url().endsWith(`/web/sites/${site.id}/files`)) publications++ })
  await page.route('**/web/session', async (route) => {
    entered()
    await hold
    await route.continue()
  }, { times: 1 })
  try {
    await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
    await preflightEntered
    await expect(dialog.getByRole('progressbar', { name: 'Upload progress' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally { release() }
  await expect(dialog.getByRole('alert')).toContainText('Upload cancelled')
  await expect(dialog.getByRole('button', { name: 'Retry publication' })).toBeEnabled()
  expect(publications).toBe(0)
  expect(await version(page, key, site.id)).toBe(1)
  const response = await page.request.get(`/api/sites/${site.id}/files`, { headers: bearer(key) })
  expect((await response.json()).files.map((file: { path: string }) => file.path)).toEqual(['index.html', 'notes.txt'])
})

test('file deletion reloads after an agent publication and requires a second confirmation', async ({ page }) => {
  const { site, key } = await existingSite(page, 'delete conflict')
  await page.getByRole('button', { name: 'Delete notes.txt', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete site file' })
  await expect(dialog).toContainText('notes.txt')
  const update = await page.request.put(`/api/sites/${site.id}/files`, {
    headers: bearer(key), data: { operationId: crypto.randomUUID(), expectedVersion: site.version, files: [{ path: 'notes.txt', content: 'Agent revision\n' }] },
  })
  expect(update.status(), await update.text()).toBe(200)
  await dialog.getByRole('button', { name: 'Delete file', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('confirm deletion again')
  expect(await version(page, key, site.id)).toBe(2)
  const notes = await page.request.get(`/api/sites/${site.id}/file?path=notes.txt`, { headers: bearer(key) })
  expect(await notes.text()).toBe('Agent revision\n')
  await dialog.getByRole('button', { name: 'Delete file', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete notes.txt', exact: true })).toHaveCount(0)
  expect(await version(page, key, site.id)).toBe(3)
})

test('dashboard deletion retains the open editor draft and does not recreate the missing file on save', async ({ page }) => {
  const { site, key } = await existingSite(page, 'retained draft')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?${new URLSearchParams({ site: site.id, view: 'files', file: 'notes.txt' })}`)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await expect(page.getByLabel('Source code: notes.txt')).toContainText('Original notes')
  await workspace.getByRole('button', { name: 'Edit file', exact: true }).click()
  const draft = 'Keep this local draft after deletion\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)
  await workspace.getByRole('button', { name: 'Delete notes.txt', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete site file' })
  const manifestRefreshed = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().includes(`/web/sites/${site.id}/files?revisionId=`) && response.ok())
  await dialog.getByRole('button', { name: 'Delete file', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await manifestRefreshed
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
  await expect(workspace.getByRole('status')).toHaveText('Unsaved changes')
  await page.setViewportSize({ width: 390, height: 844 })
  const chooser = workspace.getByLabel('Choose file')
  await expect(chooser.locator('option[value="notes.txt"]')).toHaveCount(1)
  await chooser.selectOption('index.html')
  await expect(page.getByLabel('Source code: index.html')).toContainText('Original page')
  await chooser.selectOption('notes.txt')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('alert')).toContainText('Your draft is preserved')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
  expect(await version(page, key, site.id)).toBe(2)
  const missing = await page.request.get(`/api/sites/${site.id}/file?path=notes.txt`, { headers: bearer(key) })
  expect(missing.status()).toBe(404)
})

test('a folder published to an existing public site retains its prefix and shows immediate visibility', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-pages-existing-folder-'))
  const folder = join(root, 'public-docs')
  await mkdir(folder)
  await writeFile(join(folder, 'index.html'), '<h1>Nested page</h1>')
  await writeFile(join(folder, 'readme.md'), '# Nested guide')
  try {
    const { site, key } = await existingSite(page, 'public folder')
    const visibility = await page.request.put(`/api/sites/${site.id}/visibility`, {
      headers: bearer(key), data: { operationId: crypto.randomUUID(), expectedVersion: site.version, visibility: 'public' },
    })
    expect(visibility.status(), await visibility.text()).toBe(200)
    await page.reload()
    await page.getByLabel('Upload folder', { exact: true }).setInputFiles(folder)
    const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
    await expect(dialog).toContainText('This site is public. Changes are visible to visitors immediately.')
    await expect(dialog.getByLabel('Publication files')).toContainText('public-docs/index.html')
    await expect(dialog.getByLabel('Publication files')).toContainText('public-docs/readme.md')
    await expect(dialog).toContainText('2 new · 0 overwritten')
    await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const response = await page.request.get(`/api/sites/${site.id}/files`, { headers: bearer(key) })
    expect((await response.json()).files.map((file: { path: string }) => file.path)).toEqual(['index.html', 'notes.txt', 'public-docs/index.html', 'public-docs/readme.md'])
    const original = await page.request.get(`/api/sites/${site.id}/file?path=index.html`, { headers: bearer(key) })
    expect(await original.text()).toBe('<h1>Original page</h1>')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a folder name beyond the site name limit blocks creation until shortened', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-pages-long-folder-'))
  const folderName = 'x'.repeat(101)
  const folder = join(root, folderName)
  await mkdir(folder)
  await writeFile(join(folder, 'index.html'), '<h1>Valid content</h1>')
  try {
    await signIn(page)
    await page.getByRole('button', { name: 'Sites', exact: true }).click()
    await page.getByRole('button', { name: 'New site', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New site', exact: true })
    await dialog.getByLabel('Upload folder', { exact: true }).setInputFiles(folder)
    await expect(dialog.getByLabel('Site name')).toHaveValue(folderName)
    await expect(dialog.getByRole('alert')).toContainText('Site name must be 100 characters or fewer.')
    await expect(dialog.getByRole('button', { name: 'Create site', exact: true })).toBeDisabled()
    await dialog.getByLabel('Site name').fill('A valid shorter name')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Create site', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Create site', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'A valid shorter name', exact: true })).toBeVisible()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cancelling a partially transferred multipart upload through TLS preserves the active revision', async ({ page }) => {
  const { site, key } = await existingSite(page, 'transfer cancellation')
  const uploadId = crypto.randomUUID()
  const statePath = `/__test/upload-state/${uploadId}`
  await page.route(`**/web/sites/${site.id}/files`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await route.continue({ headers: { ...route.request().headers(), 'x-agent-pages-test-paused-upload': uploadId } })
  })
  try {
    await page.getByLabel('Upload files', { exact: true }).setInputFiles({ name: 'interrupted.txt', mimeType: 'text/plain', buffer: Buffer.alloc(20 * 1024 * 1024, 65) })
    const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
    await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
    await expect.poll(async () => {
      const response = await page.request.get(statePath)
      return response.ok() ? (await response.json()).forwardedBytes as number : 0
    }).toBeGreaterThan(0)
    const progress = dialog.getByRole('progressbar', { name: 'Upload progress' })
    await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(0)
    expect(Number(await progress.getAttribute('value'))).toBeLessThan(100)
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Upload cancelled')
    // Drain only after cancellation so Node can observe the peer's disconnect
    // behind the buffered TLS bytes, without artificially aborting upstream.
    const resumed = await page.request.post(statePath)
    expect(resumed.status()).toBe(204)
    await expect.poll(async () => {
      const response = await page.request.get(statePath)
      const state = await response.json() as { aborted: boolean; upstreamClosed: boolean }
      return state.aborted && state.upstreamClosed
    }).toBe(true)
    const interrupted = await (await page.request.get(statePath)).json() as { forwardedBytes: number }
    expect(interrupted.forwardedBytes).toBeLessThan(20 * 1024 * 1024)
    expect(await version(page, key, site.id)).toBe(1)
    const response = await page.request.get(`/api/sites/${site.id}/files`, { headers: bearer(key) })
    expect((await response.json()).files.map((file: { path: string }) => file.path)).toEqual(['index.html', 'notes.txt'])
  } finally {
    await page.request.delete(statePath)
  }
})
