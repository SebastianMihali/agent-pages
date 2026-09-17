import { expect, test } from '@playwright/test'
import { signIn } from './support'

test('empty sites use the full content area and guide the owner to API keys', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await page.route('**/web/sites', (route) => route.fulfill({ json: { sites: [], cursor: null } }))
  await page.route('**/web/keys', (route) => route.fulfill({ json: { keys: [] } }))
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No sites', exact: true })).toBeVisible()
  await expect(page.getByText('Select a site to view details.')).toHaveCount(0)
  await expect(page.getByText('Publish your first site', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'New site', exact: true }).last().click()
  const creation = page.getByRole('dialog', { name: 'New site', exact: true })
  await expect(creation).toContainText('Your new site is private.')
  await creation.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Manage API keys' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your first agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Create your first key' }).click()
  await expect(page.getByLabel('Key label')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('failed and pending list requests do not claim that the account is empty', async ({ page }) => {
  await signIn(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/web/sites', async (route) => {
    await pending
    await route.fulfill({ status: 503, json: { error: { code: 'BUSY', message: 'Please retry loading sites.' } } })
  })
  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await expect(page.getByLabel('Loading sites')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No sites', exact: true })).toHaveCount(0)
  release()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No sites', exact: true })).toHaveCount(0)
  await page.route('**/web/keys', (route) => route.fulfill({ status: 503, json: { error: { code: 'BUSY', message: 'Please retry loading keys.' } } }))
  await page.getByRole('button', { name: 'API keys', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect your first agent' })).toHaveCount(0)
})
