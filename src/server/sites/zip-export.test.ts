import { mkdtemp, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { parseConfig } from '../config'
import { openDatabase } from '../db'
import { createSiteModule, type SiteModuleOptions } from '.'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of dispose.splice(0)) await close() })

async function fixture(options: SiteModuleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-export-'))
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: dataDir, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
  const db = openDatabase(dataDir)
  const sites = await createSiteModule(config, db, options)
  dispose.push(async () => { await sites.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
  return { sites, owner: { ownerId: 'owner' }, dataDir }
}

it('exports every file with its original relative path and exact bytes, without internal metadata', async () => {
  const { sites, owner } = await fixture()
  const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Untrusted " name', files: [
    { path: 'index.html', content: '<h1>Export</h1>' },
    { path: 'nested/caffè.txt', content: 'Caffè ☕' },
    { path: 'empty.txt', content: '' },
    { path: 'assets/image.png', body: new Uint8Array([137, 80, 78, 71, 0, 255]), maximumBytes: 6 },
  ] })
  const archive = await sites.exportSite(owner, created.site.id)
  expect(archive.revisionId).toBe(created.site.revisionId)
  const entries = unzipSync(new Uint8Array(await new Response(archive.body).arrayBuffer()))
  expect(Object.keys(entries).sort()).toEqual(['assets/image.png', 'empty.txt', 'index.html', 'nested/caffè.txt'])
  expect(entries['assets/image.png']).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255]))
  expect(entries['empty.txt']).toHaveLength(0)
  expect(new TextDecoder().decode(entries['index.html'])).toBe('<h1>Export</h1>')
  expect(new TextDecoder().decode(entries['nested/caffè.txt'])).toBe('Caffè ☕')
  expect(await sites.getSite(owner, created.site.id)).toEqual(created.site)
})

it('exports accepted POSIX colon paths with an explicit relative prefix when they resemble Windows drives', async () => {
  const { sites, owner } = await fixture()
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'POSIX paths', files: [
    { path: 'index.html', content: 'root' }, { path: 'a:notes.txt', content: 'colon filename' },
    { path: 'C:/page.html', content: 'colon directory' }, { path: 'nested/a:notes.txt', content: 'nested colon' },
  ] })
  const archive = await sites.exportSite(owner, site.id)
  const entries = unzipSync(new Uint8Array(await new Response(archive.body).arrayBuffer()))
  expect(Object.keys(entries).sort()).toEqual(['./C:/page.html', './a:notes.txt', 'index.html', 'nested/a:notes.txt'])
  expect(new TextDecoder().decode(entries['./a:notes.txt'])).toBe('colon filename')
  expect(new TextDecoder().decode(entries['./C:/page.html'])).toBe('colon directory')
})

it('holds export capacity until consumption or cancellation and frees it for the next download', async () => {
  const { sites, owner } = await fixture()
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Capacity', files: [
    { path: 'index.html', content: 'x'.repeat(1024 * 1024) },
  ] })
  const first = await sites.exportSite(owner, site.id)
  const second = await sites.exportSite(owner, site.id)
  await expect(sites.exportSite(owner, site.id)).rejects.toMatchObject({ code: 'BUSY' })
  await first.body.cancel()
  const next = await sites.exportSite(owner, site.id)
  await next.body.cancel()
  await second.body.cancel()
})

it.each(['abort', 'timeout', 'shutdown'])('interrupts a download and releases its revision on %s', async (reason) => {
  const { sites, owner } = await fixture()
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Interrupted', expiresInSeconds: null,
    files: [{ path: 'index.html', content: 'x'.repeat(1024 * 1024) }] })
  const abort = new AbortController()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const archive = await sites.exportSite(owner, site.id, abort.signal)
  if (reason === 'abort') abort.abort()
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(300_000)
  if (reason === 'shutdown') await sites.close()
  vi.useRealTimers()
  await expect(new Response(archive.body).arrayBuffer().then(() => 'completed')).rejects.toThrow('export')
  if (reason !== 'shutdown') {
    await sites.deleteSite(owner, { siteId: site.id, operationId: crypto.randomUUID(), expectedVersion: 1 })
    await expect.poll(async () => (await sites.runCleanup()).removedSites).toBe(1)
  }
})

it('pins all files beyond a listing page to one revision until the archive is consumed', async () => {
  const { sites, owner } = await fixture()
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Snapshot', expiresInSeconds: null,
    files: [{ path: 'a.txt', content: 'a'.repeat(1024 * 1024) }, { path: 'index.html', content: 'original' }] })
  const added = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 1,
    files: Array.from({ length: 100 }, (_, index) => ({ path: `nested/${index}.txt`, content: String(index) })) })
  const archive = await sites.exportSite(owner, site.id)
  const updated = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 2,
    files: [{ path: 'index.html', content: 'new revision' }, { path: 'later.txt', content: 'new file' }] })
  await sites.runCleanup(new Date(Date.now() + 86_400_000))
  const entries = unzipSync(new Uint8Array(await new Response(archive.body).arrayBuffer()))
  expect(Object.keys(entries)).toHaveLength(102)
  expect(new TextDecoder().decode(entries['index.html'])).toBe('original')
  expect(new TextDecoder().decode(entries['nested/99.txt'])).toBe('99')
  expect(archive.revisionId).toBe(added.site.revisionId)
  expect(await sites.getSite(owner, site.id)).toEqual(updated.site)
  expect((await sites.runCleanup(new Date(Date.now() + 86_400_000))).removedRevisions).toBe(1)
})

it('denies other owners even for public sites, and denies expired and deleted sites', async () => {
  let instant = new Date('2026-01-01T00:00:00Z')
  const { sites, owner } = await fixture({ now: () => instant })
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Access', expiresInSeconds: 60,
    files: [{ path: 'index.html', content: 'secret' }] })
  const other = { ownerId: 'other-owner' }
  await expect(sites.exportSite(other, site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await sites.setVisibility(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 1, visibility: 'public' })
  await expect(sites.exportSite(other, site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  instant = new Date('2026-01-01T00:01:00Z')
  await expect(sites.exportSite(owner, site.id)).rejects.toMatchObject({ code: 'SITE_EXPIRED' })
  await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 2 })
  await expect(sites.exportSite(owner, site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it.each(['cancel', 'missing-file', 'truncated-file', 'delete'])('releases an in-flight archive after %s without succeeding with a partial ZIP', async (reason) => {
  const { sites, owner, dataDir } = await fixture()
  const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Failure', expiresInSeconds: null,
    files: [{ path: 'a.txt', content: 'a'.repeat(1024 * 1024) }, { path: 'index.html', content: 'must be present' }] })
  const archive = await sites.exportSite(owner, site.id)
  const reader = archive.body.getReader()
  await reader.read()
  await reader.read()
  if (reason === 'cancel') await reader.cancel()
  if (reason === 'missing-file') await rm(join(dataDir, 'sites', site.id, 'revisions', site.revisionId, 'files', 'index.html'))
  if (reason === 'truncated-file') await truncate(join(dataDir, 'sites', site.id, 'revisions', site.revisionId, 'files', 'index.html'), 1)
  if (reason === 'delete') await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 1 })
  if (reason !== 'cancel') {
    await expect((async () => { while (!(await reader.read()).done) { /* Drain to the terminal result. */ } })()).rejects.toThrow('export')
  }
  if (reason !== 'delete') await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 1 })
  await expect.poll(async () => (await sites.runCleanup()).removedSites).toBe(1)
})
