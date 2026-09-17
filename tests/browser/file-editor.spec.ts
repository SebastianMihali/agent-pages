import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { CreateResult } from '../../src/server/sites'
import { appOrigin, bearer, createSite, issueKey, signIn } from './support'

const sourceHtml = [
  '<script>globalThis.__ownerSourceExecuted = true</script>',
  '<h1>HTML stays source</h1>',
  '<img src="missing" onerror="globalThis.__ownerSourceExecuted = true">',
].join('\n')
const sourceCss = 'body { color: slateblue; }\n'
const sourceJavaScript = 'export const answer = 42\n'
const sourceSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Safe source</text></svg>\n'
const sourceText = Array.from({ length: 160 }, (_, index) => `plain text notes line ${index + 1}`).join('\n') + '\n'
const testKeyLabelPrefixes = [
  'File editor ',
  'Conflict editor ',
  'Navigation guard ',
  'Expiration draft ',
  'Deleted draft ',
  'Ambiguous save ',
]

test.afterEach(async ({ page }) => {
  const sessionResponse = await page.request.get('/web/session')
  if (!sessionResponse.ok()) return
  const session = await sessionResponse.json() as { authenticated: boolean; csrfToken: string }
  if (!session.authenticated) return

  const keysResponse = await page.request.get('/web/keys')
  if (!keysResponse.ok()) return
  const { keys } = await keysResponse.json() as { keys: Array<{ id: string; label: string }> }
  const ownedKeys = keys.filter((key) => testKeyLabelPrefixes.some((prefix) => key.label.startsWith(prefix)))
  for (const key of ownedKeys) {
    const response = await page.request.post(`/web/keys/${encodeURIComponent(key.id)}/revoke`, {
      headers: { origin: appOrigin },
      data: { csrfToken: session.csrfToken },
    })
    expect(response.status(), await response.text()).toBe(200)
  }
})

test('the owner reads and edits source files across desktop and mobile layouts', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `File editor ${browser.browserType().name()} ${Date.now()}`)
  const name = `Editable files ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: sourceHtml },
    { path: 'styles.css', content: sourceCss },
    { path: 'app.js', content: sourceJavaScript },
    { path: 'images/icon.svg', content: sourceSvg },
    { path: 'notes.txt', content: sourceText },
    ...Array.from({ length: 35 }, (_, index) => ({
      path: `pages/page-${String(index + 1).padStart(2, '0')}.html`,
      content: `<h1>Page ${index + 1}</h1>\n`,
    })),
  ])

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  const mobileChooser = workspace.getByLabel('Choose file')
  const htmlButton = desktopFileButton(workspace, 'index.html')

  await expect(htmlButton).toBeVisible()
  await expect(mobileChooser).toBeHidden()
  await htmlButton.click()
  const htmlEditor = page.getByLabel('Source code: index.html')
  await expect(htmlEditor).toHaveAttribute('contenteditable', 'false')
  await expect(htmlEditor).toContainText('globalThis.__ownerSourceExecuted = true')
  expect(await page.evaluate(() => Reflect.get(globalThis, '__ownerSourceExecuted'))).toBeUndefined()
  await expectNoHorizontalOverflow(page)
  await expectEditorFitsViewport(page)
  const lastFile = desktopFileButton(workspace, 'pages/page-35.html')
  await lastFile.scrollIntoViewIfNeeded()
  await expect(lastFile).toBeVisible()
  expect(await lastFile.evaluate((button) => button.parentElement!.scrollTop)).toBeGreaterThan(0)

  await desktopFileButton(workspace, 'styles.css').click()
  const cssEditor = page.getByLabel('Source code: styles.css')
  await expect(cssEditor).toContainText(sourceCss.trim())
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const cssDraft = 'body { color: rebeccapurple; background: white; }\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(cssDraft)
  await expect(workspace.getByRole('status')).toHaveText('Unsaved changes')
  await workspace.getByRole('button', { name: 'Compare' }).click()
  await expect(workspace.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'true')
  await expect(workspace.locator('.cm-deletedChunk, .cm-changedLine').first()).toBeVisible()
  await workspace.getByRole('button', { name: 'Compare' }).click()
  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('status')).toHaveText('Changes saved.')
  expect(await readApiFile(page, key, site.id, 'styles.css')).toBe(cssDraft)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(mobileChooser).toBeVisible()
  await expect(htmlButton).toBeHidden()
  await mobileChooser.selectOption('app.js')
  await expect(page.getByLabel('Source code: app.js')).toContainText(sourceJavaScript.trim())
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const javascriptDraft = 'export const answer = 84\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(javascriptDraft)
  await expect(workspace.getByRole('status')).toHaveText('Unsaved changes')
  await expectInViewport(workspace.getByRole('button', { name: 'Save changes' }), page)
  await expectEditorFitsViewport(page)

  await mobileChooser.selectOption('images/icon.svg')
  await expect(page.getByLabel('Source code: images/icon.svg')).toContainText('Safe source')
  await mobileChooser.selectOption('notes.txt')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText('plain text notes line 1')
  await mobileChooser.selectOption('app.js')
  await expect(page.getByLabel('Source code: app.js')).toContainText(javascriptDraft.trim())
  await workspace.getByRole('button', { name: 'Undo edit' }).click()
  await expect(page.getByLabel('Source code: app.js')).toContainText(sourceJavaScript.trim())
  await expect(workspace.getByRole('status')).toHaveText('All changes saved')

  await mobileChooser.selectOption('notes.txt')
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const notesEditor = page.getByLabel('Source code: notes.txt')
  const editTooltipTarget = workspace.getByRole('button', { name: 'Compare' })
  await editTooltipTarget.focus()
  await expect(page.getByRole('tooltip', { name: 'Compare' })).toBeVisible()
  const scroller = notesEditor.locator('xpath=ancestor::*[contains(@class,"cm-editor")]').locator('.cm-scroller')
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await notesEditor.press('ControlOrMeta+A')
  // CodeMirror paints the selection in its next measurement frame.
  await expect.poll(() => notesEditor.evaluate((element) => {
    const nativeSelection = getComputedStyle(element, '::selection')
    const drawnSelection = element.closest('.cm-editor')?.querySelector('.cm-selectionBackground')
    return {
      nativeBackground: nativeSelection.backgroundColor,
      nativeColor: nativeSelection.color,
      drawnBackground: drawnSelection ? getComputedStyle(drawnSelection).backgroundColor : null,
    }
  })).toEqual({
    nativeBackground: 'rgba(0, 0, 0, 0)',
    nativeColor: 'rgb(15, 23, 42)',
    drawnBackground: 'rgb(191, 219, 254)',
  })
  await page.setViewportSize({ width: 844, height: 390 })
  await expectEditorFitsViewport(page)
  await expectInViewport(workspace.getByRole('button', { name: 'Save changes' }), page)
  const downloadStarted = page.waitForEvent('download')
  await workspace.getByRole('link', { name: 'Download file' }).click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toBe('notes.txt')
  expect(await download.failure()).toBeNull()
  expect(await readFile((await download.path())!, 'utf8')).toBe(sourceText)
  await expectNoHorizontalOverflow(page)
})

test('an agent update requires review before the owner deliberately keeps a draft', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Conflict editor ${browser.browserType().name()} ${Date.now()}`)
  const name = `Conflicting file ${browser.browserType().name()} ${Date.now()}`
  const original = '<h1>Original content</h1>\n'
  const ownerDraft = '<h1>Owner draft</h1>\n'
  const agentContent = '<h1>Agent update</h1>\n'
  const { site } = await createSite(page.request, key, name, [{ path: 'index.html', content: original }])

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'index.html').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  await workspace.locator('.cm-content[contenteditable=true]').fill(ownerDraft)

  const agentUpdate = await page.request.put(`/api/sites/${site.id}/files`, {
    headers: bearer(key),
    data: {
      operationId: crypto.randomUUID(),
      expectedVersion: site.version,
      files: [{ path: 'index.html', content: agentContent }],
    },
  })
  expect(agentUpdate.status(), await agentUpdate.text()).toBe(200)

  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('alert')).toHaveText(
    'This site changed after you opened the file. Review the current content before saving your draft.',
  )
  await expect(workspace.getByText('Your draft is safe', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Source code: index.html')).toContainText(ownerDraft.trim())
  await expect(workspace.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'true')
  await expect(workspace.locator('.cm-deletedChunk, .cm-changedLine').first()).toBeVisible()
  await expect(workspace.getByRole('button', { name: 'Save changes' })).toBeDisabled()

  await workspace.getByRole('button', { name: 'Keep my draft' }).click()
  await expect(workspace.getByRole('alert')).toHaveCount(0)
  await expect(workspace.getByRole('status')).toHaveText('Current content reviewed. Save to publish your draft.')
  await expect(workspace.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('status')).toHaveText('Changes saved.')
  expect(await readApiFile(page, key, site.id, 'index.html')).toBe(ownerDraft)
})

test('navigation asks before discarding an unsaved draft', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Navigation guard ${browser.browserType().name()} ${Date.now()}`)
  const firstName = `Guarded draft ${browser.browserType().name()} ${Date.now()}`
  await createSite(page.request, key, firstName, [
    { path: 'index.html', content: '<h1>Guarded draft</h1>\n' },
    { path: 'notes.txt', content: 'original draft\n' },
  ])

  await openSiteFromSites(page, firstName)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'notes.txt').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const draft = 'keep this navigation draft\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)

  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Leave unsaved changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expectEditorBreadcrumb(page, firstName, 'notes.txt')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())

  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard and leave' }).click()
  await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible()
  await expect(page.getByLabel('Source code: notes.txt')).toHaveCount(0)
})

test('a direct file editor URL survives reload and guards the route back to site detail', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `File editor direct ${browser.browserType().name()} ${Date.now()}`)
  const name = `Direct editor ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Direct editor</h1>\n' },
    { path: 'notes.txt', content: 'direct route content\n' },
  ])
  const search = new URLSearchParams({ site: site.id, view: 'files', file: 'notes.txt' })

  await page.goto(`/?${search}`)
  await expectEditorBreadcrumb(page, name, 'notes.txt')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText('direct route content')
  await page.reload()
  await expectEditorBreadcrumb(page, name, 'notes.txt')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText('direct route content')

  const workspace = page.getByRole('region', { name: 'File workspace' })
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const draft = 'direct route draft survives cancelled navigation\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)
  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Leave unsaved changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(new RegExp(`site=${site.id}.*view=files`))
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
})

test('a draft remains mounted when the browser clock passes the site expiration', async ({ browser, page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Expiration draft ${browser.browserType().name()} ${Date.now()}`)
  const name = `Expiring draft ${browser.browserType().name()} ${Date.now()}`
  const created = await createExpiringSite(page.request, key, name, 'notes.txt', 'before expiration\n')

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'notes.txt').click()
  await expect(page.getByLabel('Source code: notes.txt')).toContainText('before expiration')
  await page.clock.setSystemTime(new Date(Date.parse(created.site.expiresAt!) + 1_000))

  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const draft = 'edited after the browser clock advanced\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)
  await expect(page.getByRole('region', { name: 'File workspace' })).toBeVisible()
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
  await expect(workspace.getByRole('status')).toHaveText('Unsaved changes')
})

test('a deleted file remains available while its local draft is unsaved', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Deleted draft ${browser.browserType().name()} ${Date.now()}`)
  const name = `Retained deleted draft ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'notes.txt', content: 'saved notes\n' },
    { path: 'index.html', content: '<h1>Saved page</h1>\n' },
  ])

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'notes.txt').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const deletedDraft = 'local notes survive deletion\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(deletedDraft)

  await desktopFileButton(workspace, 'index.html').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const pageDraft = '<h1>Owner page draft</h1>\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(pageDraft)
  const deletion = await page.request.post(`/api/sites/${site.id}/files/delete`, {
    headers: bearer(key),
    data: { operationId: crypto.randomUUID(), expectedVersion: site.version, paths: ['notes.txt'] },
  })
  expect(deletion.status(), await deletion.text()).toBe(200)

  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByText('Your draft is safe', { exact: true })).toBeVisible()
  await workspace.getByRole('button', { name: 'Keep my draft' }).click()
  const manifestRefreshed = page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && response.url().includes(`/web/sites/${site.id}/files?revisionId=`)
    && response.ok()
  ))
  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('status')).toHaveText('Changes saved.')
  await manifestRefreshed

  const retainedButton = desktopFileButton(workspace, 'notes.txt')
  await expect(retainedButton).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  const chooser = workspace.getByLabel('Choose file')
  await expect(chooser.locator('option[value="notes.txt"]')).toHaveCount(1)
  await chooser.selectOption('notes.txt')
  const retainedEditor = page.getByLabel('Source code: notes.txt')
  await expect(retainedEditor).toHaveAttribute('contenteditable', 'true')
  await expect(retainedEditor).toContainText(deletedDraft.trim())
})

test('an ambiguous save keeps its operation through a failed authentication preflight', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Ambiguous save ${browser.browserType().name()} ${Date.now()}`)
  const name = `Retrying editor ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Retrying editor</h1>\n' },
    { path: 'notes.txt', content: 'before retry\n' },
  ])

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'notes.txt').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const draft = 'saved despite a lost response\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)

  const commands: Array<{ operationId?: string }> = []
  let loseFirstResponse = true
  await page.route(`**/web/sites/${site.id}/file`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    commands.push(route.request().postDataJSON() as { operationId?: string })
    if (!loseFirstResponse) return route.continue()
    loseFirstResponse = false
    const response = await route.fetch()
    expect(response.status(), await response.text()).toBe(200)
    await route.abort('failed')
  })

  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('button', { name: 'Retry save' })).toBeVisible()
  await expect(page.getByLabel('Source code: notes.txt')).toHaveAttribute('contenteditable', 'false')

  let rejectOnePreflight = true
  await page.route('**/web/session', async (route) => {
    if (!rejectOnePreflight) return route.continue()
    rejectOnePreflight = false
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, csrfToken: 'expired-test-challenge' }),
    })
  })
  await workspace.getByRole('button', { name: 'Retry save' }).click()
  await expect(workspace.getByRole('alert')).toContainText('Sign in again to save. Your draft is still here.')
  await expect(workspace.getByRole('button', { name: 'Retry save' })).toBeVisible()
  await expect(page.getByLabel('Source code: notes.txt')).toHaveAttribute('contenteditable', 'false')

  await workspace.getByRole('button', { name: 'Retry save' }).click()
  await expect(workspace.getByRole('status')).toHaveText('Changes saved.')
  expect(commands).toHaveLength(2)
  expect(commands[1]?.operationId).toBe(commands[0]?.operationId)
  expect(await readApiFile(page, key, site.id, 'notes.txt')).toBe(draft)
})

test('a definitive retry failure unfreezes an ambiguously retained draft', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page)
  const key = await issueKey(page, `Ambiguous save ${browser.browserType().name()} definitive ${Date.now()}`)
  const name = `Definitive retry ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Definitive retry</h1>\n' },
    { path: 'notes.txt', content: 'before failed retry\n' },
  ])

  await openSiteFromSites(page, name)
  const workspace = page.getByRole('region', { name: 'File workspace' })
  await desktopFileButton(workspace, 'notes.txt').click()
  await workspace.getByRole('button', { name: 'Edit file' }).click()
  const draft = 'retain after the server rejects retry\n'
  await workspace.locator('.cm-content[contenteditable=true]').fill(draft)

  let abortBeforeCommit = true
  await page.route(`**/web/sites/${site.id}/file`, async (route) => {
    if (route.request().method() !== 'PUT' || !abortBeforeCommit) return route.continue()
    abortBeforeCommit = false
    await route.abort('failed')
  })
  await workspace.getByRole('button', { name: 'Save changes' }).click()
  await expect(workspace.getByRole('button', { name: 'Retry save' })).toBeVisible()
  await expect(page.getByLabel('Source code: notes.txt')).toHaveAttribute('contenteditable', 'false')

  const deletion = await page.request.delete(`/api/sites/${site.id}`, {
    headers: bearer(key),
    data: { operationId: crypto.randomUUID(), expectedVersion: site.version },
  })
  expect(deletion.status(), await deletion.text()).toBe(200)

  await workspace.getByRole('button', { name: 'Retry save' }).click()
  await expect(workspace.getByRole('alert')).toBeVisible()
  await expect(workspace.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  await expect(page.getByLabel('Source code: notes.txt')).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
  await expect(workspace.getByRole('button', { name: 'Discard' })).toBeEnabled()
  await workspace.getByRole('button', { name: 'Discard' }).click()
  const dialog = page.getByRole('dialog', { name: 'Discard file changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.getByLabel('Source code: notes.txt')).toContainText(draft.trim())
})

async function openSiteFromSites(page: Page, name: string) {
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(escapeRegExp(name)) }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Site files' })).toBeVisible()
  await page.getByRole('button', { name: 'Open file editor', exact: true }).click()
  await expectEditorBreadcrumb(page, name)
}

function desktopFileButton(workspace: Locator, path: string) {
  return workspace.getByRole('button').filter({ hasText: path })
}

async function readApiFile(page: Page, key: string, siteId: string, path: string) {
  const response = await page.request.get(`/api/sites/${siteId}/file?path=${encodeURIComponent(path)}`, {
    headers: bearer(key),
  })
  const body = await response.text()
  expect(response.status(), body).toBe(200)
  return body
}

async function createExpiringSite(request: APIRequestContext, key: string, name: string, path: string, content: string) {
  const response = await request.post('/api/sites', {
    headers: bearer(key),
    data: {
      operationId: crypto.randomUUID(),
      name,
      expiresInSeconds: 60,
      files: [{ path: 'index.html', content: '<h1>Expiring editor</h1>\n' }, { path, content }],
    },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(201)
  return JSON.parse(body) as CreateResult
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function expectEditorBreadcrumb(page: Page, siteName: string, path = 'Files') {
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb).toBeVisible()
  await expect(breadcrumb.getByRole('button', { name: 'Back to site', exact: true })).toBeVisible()
  await expect(breadcrumb).toContainText(siteName)
  await expect(breadcrumb).toContainText(path)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'File editor', exact: true })).toHaveCount(0)
  await expect(page.getByText('Private', { exact: true })).toHaveCount(0)
}

async function expectEditorFitsViewport(page: Page) {
  expect(await page.evaluate(() => ({
    body: document.body.scrollHeight <= window.innerHeight,
    document: document.documentElement.scrollHeight <= window.innerHeight,
  }))).toEqual({ body: true, document: true })
}

async function expectInViewport(locator: Locator, page: Page) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
