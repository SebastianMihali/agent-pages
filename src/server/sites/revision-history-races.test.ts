import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../config'
import { createSiteModule, type SiteModule, type SiteModuleOptions } from '.'

const roots: string[] = []
const owner = { ownerId: 'owner-1' }
const credentials = { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}` }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(overrides: Record<string, string> = {}, options: SiteModuleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-restore-races-'))
  roots.push(dataDir)
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: dataDir, MIN_FREE_DISK_MB: '1', ...credentials, ...overrides })
  const sql = new Database(join(dataDir, 'database.sqlite'))
  sql.pragma('foreign_keys = ON')
  const sites = await createSiteModule(config, { sql, close: () => sql.close() }, options)
  return { dataDir, config, sql, sites }
}

async function twoRevisions(sites: SiteModule, name: string, first: string, second: string) {
  const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name,
    expiresInSeconds: null, files: [{ path: 'index.html', content: first }] })
  const updated = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
    expectedVersion: created.site.version, files: [{ path: 'index.html', content: second }] })
  return { created, updated }
}

const fileText = async (sites: SiteModule, siteId: string) =>
  new Response((await sites.openOwnedFile(owner, { siteId, path: 'index.html' })).body).text()

function barrier() {
  let entered!: () => void
  let release!: () => void
  return { reached: new Promise<void>((resolve) => { entered = resolve }),
    resume: new Promise<void>((resolve) => { release = resolve }), entered: () => entered(), release: () => release() }
}

describe('revision restoration races and recovery', () => {
  it('rolls back an activation when receipt insertion fails in the same transaction', async () => {
    const { dataDir, sites, sql } = await fixture()
    const { created, updated } = await twoRevisions(sites, 'Receipt rollback', 'original', 'current')
    const operationId = crypto.randomUUID()
    sql.exec("CREATE TRIGGER fail_restore_receipt BEFORE INSERT ON site_operation_receipts WHEN NEW.kind='restore' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
    await expect(sites.restoreRevision(owner, { operationId, siteId: created.site.id,
      expectedVersion: updated.site.version, revisionId: created.site.revisionId })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await sites.getSite(owner, created.site.id)).toEqual(updated.site)
    expect(await fileText(sites, created.site.id)).toBe('current')
    expect((await sites.listRevisions(owner, { siteId: created.site.id })).revisions[0]?.revisionId).toBe(updated.site.revisionId)
    expect(await readdir(join(dataDir, 'sites', created.site.id, 'revisions'))).toHaveLength(2)
    sql.exec('DROP TRIGGER fail_restore_receipt')
    const restored = await sites.restoreRevision(owner, { operationId, siteId: created.site.id,
      expectedVersion: updated.site.version, revisionId: created.site.revisionId })
    expect(restored.site).toMatchObject({ version: 3, revisionId: created.site.revisionId })
    await sites.close(); sql.close()
  })

  it('reserves active growth across simultaneous restores of different sites', async () => {
    const pause = barrier()
    let holding = false
    const { sites, sql } = await fixture({ MAX_TOTAL_SITE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_FILE_SIZE_MB: '1' }, {
      async fault(point) { if (holding && point === 'before-restore-commit') { holding = false; pause.entered(); await pause.resume } },
    })
    const first = await twoRevisions(sites, 'First', 'a'.repeat(600_000), 'a')
    const second = await twoRevisions(sites, 'Second', 'b'.repeat(600_000), 'b')
    const command = { operationId: crypto.randomUUID(), siteId: first.created.site.id,
      expectedVersion: first.updated.site.version, revisionId: first.created.site.revisionId }
    holding = true
    const pending = sites.restoreRevision(owner, command)
    await pause.reached
    await expect(sites.restoreRevision(owner, { operationId: crypto.randomUUID(), siteId: second.created.site.id,
      expectedVersion: second.updated.site.version, revisionId: second.created.site.revisionId })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    pause.release()
    expect((await pending).site.version).toBe(3)
    expect(await fileText(sites, first.created.site.id)).toBe('a'.repeat(600_000))
    expect(await fileText(sites, second.created.site.id)).toBe('b')
    await sites.close(); sql.close()
  })

  it('keeps a leased revision on disk when expiry cleanup tombstones during restoration', async () => {
    let instant = new Date('2026-01-01T00:00:00Z')
    const pause = barrier()
    let holding = false
    const { dataDir, sites, sql } = await fixture({}, { now: () => instant,
      async fault(point) { if (holding && point === 'before-restore-commit') { holding = false; pause.entered(); await pause.resume } },
    })
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Expiring',
      expiresInSeconds: 60, files: [{ path: 'index.html', content: 'historical' }] })
    const updated = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
      expectedVersion: 1, files: [{ path: 'index.html', content: 'current' }] })
    holding = true
    const pending = sites.restoreRevision(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
      expectedVersion: updated.site.version, revisionId: created.site.revisionId })
    await pause.reached
    instant = new Date('2026-01-01T00:01:01Z')
    expect(await sites.runCleanup(instant)).toEqual({ removedRevisions: 0, removedSites: 0 })
    expect(await readFile(join(dataDir, 'sites', created.site.id, 'revisions', created.site.revisionId, 'files', 'index.html'), 'utf8')).toBe('historical')
    pause.release()
    await expect(pending).rejects.toMatchObject({ code: 'SITE_EXPIRED' })
    expect(await sites.runCleanup(instant)).toMatchObject({ removedSites: 1 })
    await expect(readdir(join(dataDir, 'sites', created.site.id))).rejects.toThrow()
    await sites.close(); sql.close()
  })

  it('serializes delete and restore on one site and rejects stale or deleted commands', async () => {
    const pause = barrier()
    let holding = false
    const { sites, sql } = await fixture({}, {
      async fault(point) { if (holding && point === 'before-restore-commit') { holding = false; pause.entered(); await pause.resume } },
    })
    const { created, updated } = await twoRevisions(sites, 'Ordering', 'previous', 'current')
    holding = true
    const restore = sites.restoreRevision(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
      expectedVersion: updated.site.version, revisionId: created.site.revisionId })
    await pause.reached
    const deletion = sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
      expectedVersion: updated.site.version })
    pause.release()
    const restored = await restore
    expect(restored.site.version).toBe(3)
    await expect(deletion).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 3 } })
    await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 3 })
    await expect(sites.restoreRevision(owner, { operationId: crypto.randomUUID(), siteId: created.site.id,
      expectedVersion: 4, revisionId: updated.site.revisionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await sites.close(); sql.close()
  })

  it.each(['before-restore-commit', 'after-commit'] as const)('recovers an actual process crash at %s', async (point) => {
    const { dataDir, config, sites, sql } = await fixture()
    const { created, updated } = await twoRevisions(sites, 'Crash', 'historical', 'current')
    await sites.close(); sql.close()
    const command = { dataDir, ownerId: owner.ownerId, siteId: created.site.id, revisionId: created.site.revisionId,
      expectedVersion: updated.site.version, operationId: crypto.randomUUID(), point }
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/sites/fixtures/restore-crash-process.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, AGENT_PAGES_RESTORE_CRASH_FIXTURE: JSON.stringify(command) },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const [code, signal] = await once(child, 'exit')
    expect(code, stderr).toBe(92)
    expect(signal).toBeNull()
    const recoveredSql = new Database(join(dataDir, 'database.sqlite'))
    const recovered = await createSiteModule(config, { sql: recoveredSql, close: () => recoveredSql.close() })
    await recovered.recover()
    const committed = point === 'after-commit'
    expect(await fileText(recovered, created.site.id)).toBe(committed ? 'historical' : 'current')
    expect(await recovered.getSite(owner, created.site.id)).toMatchObject({
      version: committed ? 3 : 2, revisionId: committed ? created.site.revisionId : updated.site.revisionId,
    })
    const restored = await recovered.restoreRevision(owner, command)
    expect(restored.site).toMatchObject({ version: 3, revisionId: created.site.revisionId })
    expect(await fileText(recovered, created.site.id)).toBe('historical')
    await recovered.close(); recoveredSql.close()
  })
})
