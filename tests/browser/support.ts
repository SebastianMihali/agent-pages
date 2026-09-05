import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'
import type { CreateResult, SiteView, VisibilityResult } from '../../src/server/sites'

export const appOrigin = 'https://app.agent-pages.localhost:3443'

export async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Bentornato' })).toBeVisible()
  await page.getByLabel('Nome utente').fill('owner')
  await page.getByLabel('Password').fill('correct test password')
  await page.getByRole('button', { name: 'Accedi' }).click()
  await expect(page.getByRole('heading', { name: 'I tuoi siti' })).toBeVisible()
}

export async function issueKey(page: Page, label: string) {
  await page.getByRole('button', { name: 'Chiavi API' }).click()
  await expect(page.getByRole('heading', { name: 'Chiavi API' })).toBeVisible()
  await page.getByLabel('Etichetta chiave').fill(label)
  await page.getByRole('button', { name: 'Crea chiave' }).click()
  const input = page.getByLabel('Nuova chiave API')
  await expect(input).toHaveValue(/^agp_[A-Za-z0-9_-]{43}$/)
  return input.inputValue()
}

export async function createSite(request: APIRequestContext, key: string, name: string, files: Array<{ path: string; content: string }>) {
  const response = await request.post('/api/sites', {
    headers: { authorization: `Bearer ${key}` },
    data: { operationId: crypto.randomUUID(), name, files },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(201)
  return JSON.parse(body) as CreateResult
}

export async function setVisibility(request: APIRequestContext, key: string, site: SiteView, visibility: 'public' | 'private') {
  const response = await request.put(`/api/sites/${site.id}/visibility`, {
    headers: { authorization: `Bearer ${key}` },
    data: { operationId: crypto.randomUUID(), expectedVersion: site.version, visibility },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(200)
  return JSON.parse(body) as VisibilityResult
}

export async function uploadFont(request: APIRequestContext, key: string, site: SiteView) {
  const store = 'node_modules/.pnpm'
  const packageDirectory = (await readdir(store)).find((name) => name.startsWith('playwright-core@'))
  if (!packageDirectory) throw new Error('The pinned Playwright font fixture is unavailable')
  const assets = join(store, packageDirectory, 'node_modules/playwright-core/lib/vite/dashboard/assets')
  const fontName = (await readdir(assets)).find((name) => name.endsWith('.ttf'))
  if (!fontName) throw new Error('The pinned Playwright font fixture is unavailable')
  const font = await readFile(join(assets, fontName))
  const response = await request.put(`/api/sites/${site.id}/files`, {
    headers: { authorization: `Bearer ${key}` },
    multipart: {
      manifest: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedVersion: site.version,
        files: [{ path: 'assets/test-font.woff', partName: 'font' }],
      }),
      font: { name: 'test-font.woff', mimeType: 'font/woff', buffer: font },
    },
  })
  const body = await response.text()
  expect(response.status(), body).toBe(200)
  return JSON.parse(body) as { site: SiteView }
}

export function bearer(key: string) {
  return { authorization: `Bearer ${key}` }
}
