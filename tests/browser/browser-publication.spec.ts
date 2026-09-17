import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { appOrigin, bearer, createSite, issueKey, signIn } from './support'

test.afterEach(async ({ page }) => {
  const session = await (await page.request.get('/web/session')).json() as { authenticated: boolean; csrfToken: string }
  if (!session.authenticated) return
  const { keys } = await (await page.request.get('/web/keys')).json() as { keys: { id: string; label: string }[] }
  for (const key of keys.filter((key) => key.label.startsWith('Browser publication '))) {
    await page.request.post(`/web/keys/${key.id}/revoke`, { headers: { origin: appOrigin }, data: { csrfToken: session.csrfToken } })
  }
})

const file = (name: string, content: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) })

test('browser publication summarizes, merges, reconfirms conflicts and deletes a file', async ({ page }, testInfo) => {
  await signIn(page)
  const key = await issueKey(page, `Browser publication workflow ${Date.now()}`)
  const name = `Browser merge ${Date.now()}`
  const { site } = await createSite(page.request, key, name, [
    { path: 'index.html', content: '<h1>Original</h1>' }, { path: 'keep.css', content: 'body{}' },
  ])
  await page.goto(`/?site=${site.id}`)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await page.getByLabel('Upload files', { exact: true }).setInputFiles([
    file('index.html', '<h1>Browser revision</h1>'), file('notes.md', '# Notes'), file('.DS_Store', 'junk'),
  ])
  const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
  await expect(dialog.getByText('1 new · 1 overwritten', { exact: false })).toBeVisible()
  await expect(dialog.getByText('Ignored files (1)')).toBeVisible()
  const concurrent = await page.request.put(`/api/sites/${site.id}/files`, {
    headers: bearer(key), data: { operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'agent.txt', content: 'agent revision' }] },
  })
  expect(concurrent.status(), await concurrent.text()).toBe(200)
  await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Review the updated summary')
  expect((await (await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).json()).version).toBe(2)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('publication-mobile.png') })
  await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const response = await page.request.get(`/api/sites/${site.id}/files`, { headers: bearer(key) })
  expect((await response.json()).files.map((entry: { path: string }) => entry.path)).toEqual(['agent.txt', 'index.html', 'keep.css', 'notes.md'])
  await expect(page.getByRole('button', { name: 'Delete index.html', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Delete notes.md', exact: true }).click()
  const deletion = page.getByRole('dialog', { name: 'Delete site file' })
  await expect(deletion).toContainText('notes.md')
  await deletion.getByRole('button', { name: 'Cancel deletion' }).click()
  await expect(page.getByRole('button', { name: 'Delete notes.md', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Delete notes.md', exact: true }).click()
  await deletion.getByRole('button', { name: 'Delete file', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete notes.md', exact: true })).toHaveCount(0)
  expect((await (await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).json()).version).toBe(4)
})

test('creates a private site from a folder and blocks missing index and oversized files', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-pages-picked-'))
  const folder = join(root, 'browser-folder')
  await mkdir(folder)
  await writeFile(join(folder, 'index.html'), '<h1>Created in browser</h1>')
  await writeFile(join(folder, 'guide.md'), '# Folder guide')
  try {
    await signIn(page)
    await page.getByRole('button', { name: 'Sites', exact: true }).click()
    await page.getByRole('button', { name: 'New site', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New site', exact: true })
    await dialog.getByLabel('Upload files', { exact: true }).setInputFiles(file('notes.txt', 'no index'))
    await expect(dialog.getByRole('alert')).toContainText('requires index.html')
    await expect(dialog.getByRole('button', { name: 'Create site' })).toBeDisabled()
    await dialog.getByLabel('Upload files', { exact: true }).setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 65) })
    await expect(dialog.getByRole('alert')).toContainText('file size limit')
    await expect(dialog.getByRole('button', { name: 'Create site' })).toBeDisabled()
    await dialog.getByLabel('Upload folder', { exact: true }).setInputFiles(folder)
    await expect(dialog.getByLabel('Site name')).toHaveValue('browser-folder')
    await expect(dialog.getByText('Your new site is private.', { exact: false })).toBeVisible()
    await expect(dialog.getByLabel('Publication files')).toContainText('index.html')
    await expect(dialog.getByLabel('Publication files')).not.toContainText('browser-folder/')
    await dialog.getByRole('button', { name: 'Create site' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'browser-folder', exact: true })).toBeVisible()
    const id = new URL(page.url()).searchParams.get('site')!
    const site = await (await page.request.get(`/web/sites/${id}`)).json()
    expect(site).toMatchObject({ visibility: 'private', version: 1, fileCount: 2 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an uncertain publication reuses its operation after the response is lost', async ({ page }) => {
  const { id, key } = await existingSite(page, 'retry')
  await page.getByLabel('Upload files', { exact: true }).setInputFiles(file('retry.txt', 'once only'))
  const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
  const commands: string[] = []
  await page.route(`**/web/sites/${id}/files`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const manifest = /\r\n\r\n(\{[^\r]+\})\r\n/.exec(route.request().postData() ?? '')
    commands.push((JSON.parse(manifest![1]) as { operationId: string }).operationId)
    if (commands.length !== 1) return route.continue()
    const result = await route.fetch()
    expect(result.status(), await result.text()).toBe(200)
    await route.abort('failed')
  })
  await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Retry publication' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Retry publication' }).click()
  await expect(dialog).toHaveCount(0)
  expect(commands).toHaveLength(2)
  expect(commands[0]).toBe(commands[1])
  expect((await (await page.request.get(`/api/sites/${id}`, { headers: bearer(key) })).json()).version).toBe(2)
})

test('PDF publication preserves bytes and inline response headers on the isolated origin', async ({ page }) => {
  const { id, key } = await existingSite(page, 'pdf')
  await page.getByLabel('Upload files', { exact: true }).setInputFiles({ name: 'document.pdf', mimeType: 'text/html', buffer: pdfFixture() })
  const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
  await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const madePublic = await page.request.put(`/api/sites/${id}/visibility`, { headers: bearer(key),
    data: { operationId: crypto.randomUUID(), expectedVersion: 2, visibility: 'public' } })
  expect(madePublic.status(), await madePublic.text()).toBe(200)
  const { site } = await madePublic.json()
  const pdfUrl = new URL('/document.pdf', site.url).href
  const response = await page.request.get(pdfUrl)
  expect(response.headers()['content-type']).toBe('application/pdf')
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['content-disposition']).toBeUndefined()
  expect(await response.body()).toEqual(pdfFixture())
  // The pinned headless browsers download PDFs instead of rendering a viewer.
  // Viewer rendering remains an explicit manual release check.
})

test('the publication summary includes existing files beyond the first manifest page', async ({ page }) => {
  await signIn(page)
  const key = await issueKey(page, `Browser publication pagination ${Date.now()}`)
  const { site } = await createSite(page.request, key, 'Paginated browser publication', [
    { path: 'index.html', content: 'index' },
    ...Array.from({ length: 99 }, (_, index) => ({ path: `file-${String(index).padStart(3, '0')}.txt`, content: 'old' })),
  ])
  const added = await page.request.put(`/api/sites/${site.id}/files`, { headers: bearer(key), data: {
    operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'z-last.txt', content: 'original last file' }],
  } })
  expect(added.status(), await added.text()).toBe(200)
  await page.goto(`/?site=${site.id}`)
  await expect(page.getByRole('region', { name: 'Site files' })).toBeVisible()
  await page.getByLabel('Upload files', { exact: true }).setInputFiles(file('z-last.txt', 'replacement'))
  const dialog = page.getByRole('dialog', { name: 'Publish files', exact: true })
  await expect(dialog.getByText('0 new · 1 overwritten', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: 'Publish files', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await (await page.request.get(`/api/sites/${site.id}/file?path=z-last.txt`, { headers: bearer(key) })).text()).toBe('replacement')
  expect((await (await page.request.get(`/api/sites/${site.id}`, { headers: bearer(key) })).json()).fileCount).toBe(101)
})

function pdfFixture() {
  const content = 'BT /F1 24 Tf 40 160 Td (Agent Pages PDF) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function existingSite(page: Page, suffix: string) {
  await signIn(page)
  const key = await issueKey(page, `Browser publication ${suffix} ${Date.now()}`)
  const { site } = await createSite(page.request, key, `Browser ${suffix}`, [{ path: 'index.html', content: 'original' }])
  await page.goto(`/?site=${site.id}`)
  await expect(page.getByRole('region', { name: 'Site files' })).toBeVisible()
  return { id: site.id, key }
}
