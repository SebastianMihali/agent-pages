import { expect, test } from '@playwright/test'
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
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible()
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
