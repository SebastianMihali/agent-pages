import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { appOrigin, bearer, createSite, issueKey, signIn } from './support'

test('the owner downloads a complete ZIP from site detail on a narrow interface', async ({ browser, page }) => {
  await signIn(page)
  const key = await issueKey(page, `Export ${browser.browserType().name()} ${Date.now()}`)
  const name = `ZIP ${browser.browserType().name()} ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Downloaded</h1>' }, { path: 'nested/caffè.txt', content: 'Caffè ☕' },
  ])
  await page.getByRole('button', { name: 'Sites' }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const link = page.getByRole('link', { name: 'Export ZIP' })
  await expect(link).toBeVisible()
  const head = await page.request.head(`/web/sites/${site.id}/export`)
  expect(head.status()).toBe(405)
  expect(head.headers().allow).toBe('GET')
  const downloaded = page.waitForEvent('download')
  await link.click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe(`site-${site.id}.zip`)
  expect(await download.failure()).toBeNull()
  const entries = unzipSync(await readFile((await download.path())!))
  expect(Object.keys(entries).sort()).toEqual(['index.html', 'nested/caffè.txt'])
  expect(new TextDecoder().decode(entries['index.html'])).toBe('<h1>Downloaded</h1>')
  expect(new TextDecoder().decode(entries['nested/caffè.txt'])).toBe('Caffè ☕')
  await expect(page.getByRole('heading', { name })).toBeVisible()
  expect((await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).ok()).toBe(true)
  if (browser.browserType().name() === 'chromium') await page.screenshot({ path: 'test-results/export-mobile.png', fullPage: true })
})

test('the owner can sign in with the keyboard on a narrow production interface', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  const cspErrors: string[] = []
  page.on('console', (message) => {
    if (/content security policy|violates the following/i.test(message.text())) cspErrors.push(message.text())
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByLabel('Username')).toBeFocused()
  await page.keyboard.type('owner')
  await page.keyboard.press('Tab')
  await page.keyboard.type('correct test password')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(cspErrors).toEqual([])
  if (browser.browserType().name() === 'chromium') {
    await page.screenshot({ path: 'test-results/owner-mobile.png', fullPage: true })
  }
})

test('an API key can be copied, is shown once, and is revoked immediately', async ({ browser, context, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  if (browser.browserType().name() === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin })
  }
  await signIn(page)

  const label = `Browser ${browser.browserType().name()} ${Date.now()}`
  const key = await issueKey(page, label)

  await expect(page.getByText('Save this key now')).toBeVisible()
  await expect(page.getByText(label)).toBeVisible()
  await page.getByRole('button', { name: 'Copy API key' }).click()
  await expect(page.getByText('Copied to clipboard.')).toBeVisible()
  expect(await page.evaluate(() => `${localStorage.length}:${sessionStorage.length}`)).toBe('0:0')

  await page.getByRole('button', { name: 'Hide key' }).click()
  await expect(page.locator('body')).not.toContainText(key)
  await page.reload()
  await page.getByRole('button', { name: 'API keys' }).click()
  await expect(page.locator('body')).not.toContainText(key)

  expect((await page.request.get('/api/sites', { headers: bearer(key) })).status()).toBe(200)
  const keyRow = page.getByText(label).locator('..').locator('..')
  await keyRow.getByRole('button', { name: 'Revoke' }).click()
  await keyRow.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText(label)).toHaveCount(0)
  expect((await page.request.get('/api/sites', { headers: bearer(key) })).status()).toBe(401)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('the owner default applies to new sites and site expiration can be removed', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  await signIn(page)
  const key = await issueKey(page, `Expiration ${browser.browserType().name()} ${Date.now()}`)
  await page.getByRole('button', { name: 'Sites' }).click()
  await page.getByLabel('New sites expire after').selectOption('86400')
  await expect(page.getByLabel('New sites expire after')).toHaveValue('86400')

  const name = `One day ${browser.browserType().name()} ${Date.now()}`
  const created = await createSite(page.request, key, name, [{ path: 'index.html', content: 'short-lived' }])
  expect(Date.parse(created.site.expiresAt!) - Date.parse(created.site.createdAt)).toBe(86_400_000)
  await page.getByRole('button', { name: 'Refresh site list' }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  const metric = page.getByText('Expires', { exact: true }).locator('..')
  await expect(metric).not.toContainText('Never')

  await page.getByRole('button', { name: 'Change expiration' }).click()
  await page.getByLabel('Site expiration').selectOption('never')
  await page.getByRole('button', { name: 'Save expiration' }).click()
  await expect(metric).toContainText('Never')
})


test('the owner cancels then confirms site deletion and the remaining site stays selected', async ({ page }) => {
  await signIn(page)
  const keyLabel = `Deletion ${Date.now()}`
  const key = await issueKey(page, keyLabel)
  // The browser suite owns this isolated installation; start with an empty site list.
  const existing = await (await page.request.get('/api/sites', { headers: bearer(key) })).json()
  for (const old of existing.sites) {
    expect((await page.request.delete(`/api/sites/${old.id}`, { headers: bearer(key),
      data: { operationId: crypto.randomUUID(), expectedVersion: old.version } })).status()).toBe(200)
  }
  const remainingName = `Keep ${Date.now()}`
  const remaining = await createSite(page.request, key, remainingName, [{ path: 'index.html', content: 'keep me' }])
  const name = `Delete ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [{ path: 'index.html', content: 'delete me' }])
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Confirm site deletion' })).toContainText(name)
  await page.getByRole('button', { name: 'Cancel deletion' }).click()
  expect((await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).status()).toBe(200)
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(site.id))
  await expect(page.getByRole('status')).toContainText('Site deleted.')
  expect((await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).status()).toBe(404)
  await expect(page.getByRole('heading', { name: remainingName })).toBeVisible()
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByText('No sites', { exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(remaining.site.id))
  await page.reload()
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await expect(page.getByText('No sites', { exact: true })).toBeVisible()
  await revokeTestKey(page, keyLabel)
})


test('deletion requires fresh confirmation after an agent changes the site', async ({ page }) => {
  await signIn(page)
  const keyLabel = `Conflict ${Date.now()}`
  const key = await issueKey(page, keyLabel)
  const name = `Changed ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [{ path: 'index.html', content: 'one' }])
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  expect((await page.request.put(`/api/sites/${site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', content: 'two' }],
  } })).status()).toBe(200)
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByText('Site version does not match')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete permanently' })).toHaveCount(0)
  await expect(page.getByText('v2', { exact: true })).toBeVisible()
  expect((await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).status()).toBe(200)
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('heading', { name })).toHaveCount(0)
  await revokeTestKey(page, keyLabel)
})

test('deletion retries the same command when the successful response is lost', async ({ page }) => {
  await signIn(page)
  const keyLabel = `Retry ${Date.now()}`
  const key = await issueKey(page, keyLabel)
  const name = `Retry site ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [{ path: 'index.html', content: 'gone' }])
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  const commands: unknown[] = []
  await page.route(`**/web/sites/${site.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    commands.push(route.request().postDataJSON())
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    if (commands.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Confirm site deletion' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'API keys', exact: true }).click({ trial: true, timeout: 500 })).rejects.toThrow()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('heading', { name })).toHaveCount(0)
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  await revokeTestKey(page, keyLabel)
})


async function revokeTestKey(page: Page, label: string) {
  await page.getByRole('button', { name: 'API keys', exact: true }).click()
  const row = page.getByText(label, { exact: true }).locator('..').locator('..')
  await row.getByRole('button', { name: 'Revoke', exact: true }).click()
  await row.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByText(label, { exact: true })).toHaveCount(0)
}

test('an older list response cannot restore a deleted site', async ({ page }) => {
  await signIn(page)
  const keyLabel = `List race ${Date.now()}`
  const key = await issueKey(page, keyLabel)
  const name = `Old list ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [{ path: 'index.html', content: 'gone' }])
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let captured!: () => void
  const ready = new Promise<void>((resolve) => { captured = resolve })
  let first = true
  await page.route('**/web/sites', async (route) => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    captured()
    await held
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Refresh site list' }).click()
  await ready
  await page.getByRole('button', { name: 'Delete site', exact: true }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('status')).toContainText('Site deleted.')
  await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
  const staleResponse = page.waitForResponse((response) => response.url().endsWith('/web/sites'))
  release()
  await staleResponse
  await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
  expect((await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).status()).toBe(404)
  await revokeTestKey(page, keyLabel)
})
