import { expect, test } from '@playwright/test'
import { appOrigin, bearer, issueKey, signIn } from './support'

test('the owner can sign in with the keyboard on a narrow production interface', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  const cspErrors: string[] = []
  page.on('console', (message) => {
    if (/content security policy|violates the following/i.test(message.text())) cspErrors.push(message.text())
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Bentornato' })).toBeVisible()
  await expect(page.getByLabel('Nome utente')).toBeFocused()
  await page.keyboard.type('owner')
  await page.keyboard.press('Tab')
  await page.keyboard.type('correct test password')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'I tuoi siti' })).toBeVisible()
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

  await expect(page.getByText('Salva questa chiave ora')).toBeVisible()
  await expect(page.getByText(label)).toBeVisible()
  await page.getByRole('button', { name: 'Copia chiave API' }).click()
  await expect(page.getByText('Copiata negli appunti.')).toBeVisible()
  expect(await page.evaluate(() => `${localStorage.length}:${sessionStorage.length}`)).toBe('0:0')

  await page.getByRole('button', { name: 'Nascondi chiave' }).click()
  await expect(page.locator('body')).not.toContainText(key)
  await page.reload()
  await page.getByRole('button', { name: 'Chiavi API' }).click()
  await expect(page.locator('body')).not.toContainText(key)

  expect((await page.request.get('/api/sites', { headers: bearer(key) })).status()).toBe(200)
  const keyRow = page.getByText(label).locator('..').locator('..')
  await keyRow.getByRole('button', { name: 'Revoca' }).click()
  await keyRow.getByRole('button', { name: 'Conferma' }).click()
  await expect(page.getByText(label)).toHaveCount(0)
  expect((await page.request.get('/api/sites', { headers: bearer(key) })).status()).toBe(401)

  await page.getByRole('button', { name: 'Esci' }).click()
  await expect(page.getByRole('heading', { name: 'Bentornato' })).toBeVisible()
})
