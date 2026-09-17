import { expect, test } from '@playwright/test'
import { createSite, issueKey, signIn } from '../browser/support'

test('a file selected from site detail opens reliably in the development StrictMode runtime', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await signIn(page)
  const key = await issueKey(page, `Development editor ${Date.now()}`)
  const name = `StrictMode editor ${Date.now()}`
  const source = '<h1>Loaded in development</h1>\n'
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: source },
    { path: 'notes.txt', content: 'Development notes\n' },
  ])

  await page.getByRole('button', { name: 'Sites', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  const siteFiles = page.getByRole('region', { name: 'Site files' })
  await siteFiles.getByRole('button').filter({ hasText: 'index.html' }).click()

  await expect(page).toHaveURL(new RegExp(`site=${site.id}.*view=files.*file=index\\.html`))
  const sourceEditor = page.getByLabel('Source code: index.html')
  await expect(sourceEditor).toContainText('Loaded in development')
  await expect(page.getByText('Loading file…', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Edit file' }).click()
  await expect(sourceEditor).toHaveAttribute('contenteditable', 'true')
  await sourceEditor.click()
  const codeMirror = sourceEditor.locator('xpath=ancestor::*[contains(@class,"cm-editor")]')
  await expect(codeMirror).toHaveClass(/cm-focused/)
  expect(await codeMirror.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')

  await page.reload()
  await expect(page.getByLabel('Source code: index.html')).toContainText('Loaded in development')
  await page.getByRole('button', { name: 'Back to site', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await page.getByRole('region', { name: 'Site files' }).getByRole('button').filter({ hasText: 'index.html' }).click()
  await expect(page.getByLabel('Source code: index.html')).toContainText('Loaded in development')
})
