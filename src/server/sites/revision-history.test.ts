import Database from 'better-sqlite3'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseConfig } from '../config'
import { createSiteModule, type FileInput, type SiteModuleOptions, type SiteView } from '.'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

async function fixture(overrides: Record<string, string> = {}, options: SiteModuleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-history-'))
  const env = { NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: dataDir, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
    MIN_FREE_DISK_MB: '1', ...overrides }
  const sql = new Database(join(dataDir, 'database.sqlite')); sql.pragma('foreign_keys = ON')
  const database = { sql, close: () => sql.close() }
  const ctx = { sites: await createSiteModule(parseConfig(env), database, options), sql, dataDir, owner: { ownerId: 'owner' },
    async restart(changes: Record<string, string> = {}) {
      await ctx.sites.close()
      Object.assign(env, changes)
      ctx.sites = await createSiteModule(parseConfig(env), database, options)
      await ctx.sites.recover()
    },
    async create(content = 'original', extra: FileInput[] = []) {
      return (await ctx.sites.createSite(ctx.owner, { operationId: crypto.randomUUID(), name: 'History', expiresInSeconds: null,
        files: [{ path: 'index.html', content }, ...extra] })).site
    },
    async write(site: SiteView, content = 'updated') {
      return (await ctx.sites.writeFiles(ctx.owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: site.version,
        files: [{ path: 'index.html', content }] })).site
    },
  }
  disposals.push(async () => { await ctx.sites.close(); sql.close(); await rm(dataDir, { recursive: true, force: true }) })
  return ctx
}

const restore = (site: SiteView, revisionId: string) => ({ siteId: site.id, revisionId, expectedVersion: site.version, operationId: crypto.randomUUID() })

it('lists complete metadata and restores original binary bytes without changing site policy', async () => {
  const f = await fixture()
  const binary = new Uint8Array([0, 255, 128, 12, 13])
  const first = await f.create('original', [{ path: 'nested/image.png', body: binary, maximumBytes: binary.length }])
  const publicSite = (await f.sites.setVisibility(f.owner, { siteId: first.id, expectedVersion: first.version, operationId: crypto.randomUUID(), visibility: 'public' })).site
  const expires = (await f.sites.setExpiration(f.owner, { siteId: first.id, expectedVersion: publicSite.version, operationId: crypto.randomUUID(), expiresInSeconds: 3600 })).site
  const second = (await f.sites.deleteFiles(f.owner, { siteId: first.id, expectedVersion: expires.version, operationId: crypto.randomUUID(), paths: ['nested/image.png'] })).site
  const history = await f.sites.listRevisions(f.owner, { siteId: first.id })
  expect(history).toMatchObject({ site: second, historyLimit: 5, revisions: [
    { revisionId: second.revisionId, active: true, publishedVersion: 4, lastActivatedVersion: 4 },
    { revisionId: first.revisionId, active: false, publishedVersion: 1, lastActivatedVersion: 1, sizeBytes: 13, fileCount: 2 },
  ] })
  const restored = (await f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).site
  expect(restored).toMatchObject({ ...second, revisionId: first.revisionId, version: 5, sizeBytes: first.sizeBytes, fileCount: 2, updatedAt: expect.any(String) })
  const lease = await f.sites.acquireActiveRevision(first.id)
  expect(lease.revisionId).toBe(first.revisionId)
  expect(new Uint8Array(await new Response((await lease.open('nested/image.png')).body).arrayBuffer())).toEqual(binary)
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions[0]).toMatchObject({ publishedVersion: 1, lastActivatedVersion: 5 })
  expect((await f.sites.getOverview(f.owner)).historySizeBytes).toBe(second.sizeBytes)
})

it('records a no-op receipt, checks stale versions, and replays before reading current state', async () => {
  const f = await fixture()
  const first = await f.create(); const second = await f.write(first)
  const command = restore(second, first.revisionId)
  await expect(f.sites.restoreRevision(f.owner, { ...command, expectedVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  const result = await f.sites.restoreRevision(f.owner, command)
  const noOp = await f.sites.restoreRevision(f.owner, restore(result.site, first.revisionId))
  expect(noOp.site).toEqual(result.site)
  await expect(f.sites.restoreRevision(f.owner, { ...command, revisionId: second.revisionId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await expect(f.sites.setVisibility(f.owner, { operationId: command.operationId, siteId: first.id, expectedVersion: 3, visibility: 'public' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await f.sites.deleteSite(f.owner, { siteId: first.id, expectedVersion: result.site.version, operationId: crypto.randomUUID() })
  await f.sites.runCleanup()
  expect(await f.sites.restoreRevision(f.owner, command)).toEqual(result)
  expect(await f.sites.restoreRevision(f.owner, { ...restore(result.site, first.revisionId), operationId: noOp.operationId })).toEqual(noOp)
})

it('retains the most recently activated revisions and ignores metadata changes and unchanged writes', async () => {
  const f = await fixture({ REVISION_HISTORY_LIMIT: '1' }, { now: () => new Date('2026-01-01') })
  const first = await f.create(); const second = await f.write(first)
  const restored = (await f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).site
  const third = await f.write(restored, 'third')
  const history = await f.sites.listRevisions(f.owner, { siteId: first.id })
  expect(history.revisions.map((r) => r.revisionId)).toEqual([third.revisionId, first.revisionId])
  await expect(f.sites.restoreRevision(f.owner, restore(third, second.revisionId))).rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
  expect(await readdir(join(f.dataDir, 'sites', first.id, 'revisions'))).toHaveLength(3)
  await f.sites.runCleanup()
  expect(await readdir(join(f.dataDir, 'sites', first.id, 'revisions'))).toHaveLength(2)
  const unchanged = await f.write(third, 'third')
  const visible = await f.sites.setVisibility(f.owner, { siteId: first.id, expectedVersion: unchanged.version, operationId: crypto.randomUUID(), visibility: 'public' })
  expect(visible.site.version).toBe(third.version + 1)
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions).toEqual(history.revisions)
})

it('protects a retired revision until its reader finishes while keeping it unavailable to restore', async () => {
  const f = await fixture({ REVISION_HISTORY_LIMIT: '1' })
  const first = await f.create()
  const lease = await f.sites.acquireActiveRevision(first.id)
  try {
    const second = await f.write(first); const third = await f.write(second, 'third')
    expect((await f.sites.runCleanup()).removedRevisions).toBe(0)
    await expect(f.sites.restoreRevision(f.owner, restore(third, first.revisionId))).rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
    expect(await new Response((await lease.open('index.html')).body).text()).toBe('original')
  } finally { await lease.release() }
  expect((await f.sites.runCleanup()).removedRevisions).toBe(1)
})

it('applies a lowered limit at startup and never readmits retired revisions after increasing it', async () => {
  const f = await fixture()
  const first = await f.create(); const second = await f.write(first); const third = await f.write(second, 'third')
  await f.restart({ REVISION_HISTORY_LIMIT: '1' })
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions.map((r) => r.revisionId)).toEqual([third.revisionId, second.revisionId])
  await f.restart({ REVISION_HISTORY_LIMIT: '5' })
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions).toHaveLength(2)
  await f.restart({ REVISION_HISTORY_LIMIT: '0' })
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions).toHaveLength(1)
  await expect(f.sites.restoreRevision(f.owner, restore(third, second.revisionId))).rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
})

it('migrates old active and retired revisions without inventing versions or recovering retired content', async () => {
  const f = await fixture({ REVISION_HISTORY_LIMIT: '0' })
  const first = await f.create(); const second = await f.write(first)
  await f.sites.close()
  f.sql.exec(`DROP INDEX site_revisions_history;
    ALTER TABLE site_revisions DROP COLUMN published_version;
    ALTER TABLE site_revisions DROP COLUMN last_activated_version;
    ALTER TABLE site_revisions DROP COLUMN last_activated_at_ms;
    DELETE FROM __migrations WHERE name='0005_revision_history';`)
  await f.restart({ REVISION_HISTORY_LIMIT: '5' })
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions).toEqual([{
    revisionId: second.revisionId, active: true, publishedVersion: null, lastActivatedVersion: null,
    createdAt: second.updatedAt, lastActivatedAt: second.updatedAt, sizeBytes: second.sizeBytes, fileCount: second.fileCount,
  }])
  await f.restart()
  const third = await f.write(second, 'third')
  expect((await f.sites.restoreRevision(f.owner, restore(third, second.revisionId))).site.version).toBe(4)
})

it.each(['manifest', 'digest', 'missing', 'metadata', 'symlink'])('refuses %s corruption even when the manifest was cached, preserving the active revision', async (kind) => {
  const f = await fixture()
  const first = await f.create(); const second = await f.write(first)
  await f.sites.listFiles(f.owner, { siteId: first.id, revisionId: first.revisionId })
  const root = join(f.dataDir, 'sites', first.id, 'revisions', first.revisionId)
  const file = join(root, 'files', 'index.html')
  if (kind === 'manifest') await writeFile(join(root, 'manifest.json'), '{}')
  if (kind === 'digest') await writeFile(file, 'tampered')
  if (kind === 'missing') await rm(file)
  if (kind === 'metadata') f.sql.prepare('UPDATE site_revisions SET file_count=99 WHERE site_id=? AND id=?').run(first.id, first.revisionId)
  if (kind === 'symlink') { await rm(file); await symlink(join(f.dataDir, 'sites', first.id, 'revisions', second.revisionId, 'files', 'index.html'), file) }
  await expect(f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  expect(await f.sites.getSite(f.owner, first.id)).toEqual(second)
  // Failure must release its lease so lifecycle cleanup can complete.
  await f.sites.deleteSite(f.owner, { siteId: first.id, expectedVersion: second.version, operationId: crypto.randomUUID() })
  expect((await f.sites.runCleanup()).removedSites).toBe(1)
})

it('allows startup with corrupt history but refuses its restore', async () => {
  const f = await fixture()
  const first = await f.create(); const second = await f.write(first)
  await writeFile(join(f.dataDir, 'sites', first.id, 'revisions', first.revisionId, 'files', 'index.html'), 'broken')
  await f.restart()
  await expect(f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
})

it('rejects publication at stored capacity without sacrificing history and can still restore', async () => {
  const f = await fixture()
  const first = await f.create('a'.repeat(600 * 1024)); const second = await f.write(first, 'b'.repeat(600 * 1024))
  await f.restart({ MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1', MIN_FREE_DISK_MB: '100000000' })
  await expect(f.write(second, 'c')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  expect((await f.sites.listRevisions(f.owner, { siteId: first.id })).revisions).toHaveLength(2)
  expect((await f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).site.revisionId).toBe(first.revisionId)
})

it.each(['file', 'site', 'count', 'total'])('enforces the current %s limit on a restore', async (limit) => {
  const f = await fixture()
  const first = await f.create('a'.repeat((limit === 'site' ? 700 : 1200) * 1024),
    [{ path: 'extra.txt', content: limit === 'site' ? 'b'.repeat(700 * 1024) : 'x' }])
  let second = await f.write(first, 'tiny')
  if (limit === 'count') second = (await f.sites.deleteFiles(f.owner, { siteId: first.id, expectedVersion: second.version, operationId: crypto.randomUUID(), paths: ['extra.txt'] })).site
  const changes: Record<string, string> = limit === 'file' ? { MAX_FILE_SIZE_MB: '1' }
    : limit === 'site' ? { MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1' }
    : limit === 'count' ? { MAX_FILES_PER_SITE: '1', MAX_BATCH_FILES: '1' }
    : { MAX_FILE_SIZE_MB: '2', MAX_SITE_SIZE_MB: '2', MAX_TOTAL_SITE_SIZE_MB: '2' }
  if (limit === 'total') await f.create('other'.repeat(200 * 1024))
  await f.restart(changes)
  await expect(f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  expect(await f.sites.getSite(f.owner, first.id)).toEqual(second)
})

it('allows a restore that reduces usage after the operator lowers the active quota', async () => {
  const f = await fixture()
  const first = await f.create('small'); const second = await f.write(first, 'x'.repeat(600 * 1024))
  await f.create('y'.repeat(600 * 1024))
  await f.restart({ MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1' })
  expect((await f.sites.restoreRevision(f.owner, restore(second, first.revisionId))).site.sizeBytes).toBe(5)
})

it('denies other owners and foreign targets, even on a public site', async () => {
  const f = await fixture()
  const first = await f.create(); const foreign = await f.create('other')
  const current = (await f.sites.setVisibility(f.owner, { siteId: first.id, expectedVersion: 1, operationId: crypto.randomUUID(), visibility: 'public' })).site
  await expect(f.sites.listRevisions({ ownerId: 'other' }, { siteId: first.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(f.sites.restoreRevision({ ownerId: 'other' }, restore(current, first.revisionId))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(f.sites.restoreRevision(f.owner, restore(current, foreign.revisionId))).rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
  expect(await readFile(join(f.dataDir, 'sites', first.id, 'revisions', first.revisionId, 'files', 'index.html'), 'utf8')).toBe('original')
})
