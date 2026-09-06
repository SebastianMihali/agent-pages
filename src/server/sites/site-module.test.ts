import Database from 'better-sqlite3'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../config'
import { createSiteModule, type SiteModule, type SiteModuleOptions } from '.'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(overrides: Record<string, string> = {}, options: SiteModuleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-sites-'))
  roots.push(dataDir)
  const config = parseConfig({
    NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: dataDir, ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
    MIN_FREE_DISK_MB: '1', ...overrides,
  })
  const sql = new Database(join(dataDir, 'database.sqlite'))
  sql.pragma('foreign_keys = ON')
  const database = { sql, close: () => sql.close() }
  const sites = await createSiteModule(config, database, options)
  return { dataDir, sql, sites, owner: { ownerId: 'owner-1' } }
}

async function text(file: Awaited<ReturnType<SiteModule['openOwnedFile']>>) {
  return new Response(file.body).text()
}

describe('complete site revisions', () => {
  it('applies the seven-day owner default when creation omits expiration', async () => {
    const instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Default expiration', files: [{ path: 'index.html', content: 'temporary' }],
    })
    expect(created.site.expiresAt).toBe('2026-01-08T00:00:00.000Z')
    await sites.close(); sql.close()
  })

  it('gets and sets the owner expiration default and rejects values outside the preset allowlist', async () => {
    const { sites, sql, owner } = await fixture()
    expect(await sites.getOwnerSettings(owner)).toEqual({ defaultExpiresInSeconds: 604_800 })
    expect(await sites.setOwnerSettings(owner, { defaultExpiresInSeconds: null })).toEqual({ defaultExpiresInSeconds: null })
    expect(await sites.getOwnerSettings(owner)).toEqual({ defaultExpiresInSeconds: null })
    expect(await sites.setOwnerSettings(owner, { defaultExpiresInSeconds: 86_400 })).toEqual({ defaultExpiresInSeconds: 86_400 })
    await expect(sites.setOwnerSettings(owner, { defaultExpiresInSeconds: 60 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await sites.close(); sql.close()
  })

  it('applies the current owner default while explicit null and numbers take precedence', async () => {
    const instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    await sites.setOwnerSettings(owner, { defaultExpiresInSeconds: 86_400 })
    const inherited = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Inherited', files: [{ path: 'index.html', content: 'one day' }],
    })
    const never = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Never', expiresInSeconds: null, files: [{ path: 'index.html', content: 'forever' }],
    })
    const explicit = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Explicit', expiresInSeconds: 120, files: [{ path: 'index.html', content: 'briefly' }],
    })
    expect(inherited.site.expiresAt).toBe('2026-01-02T00:00:00.000Z')
    expect(never.site.expiresAt).toBeNull()
    expect(explicit.site.expiresAt).toBe('2026-01-01T00:02:00.000Z')
    await sites.close(); sql.close()
  })

  it('replays an omitted-expiration creation after the owner default changes', async () => {
    const { sites, sql, owner } = await fixture()
    const command = { operationId: crypto.randomUUID(), name: 'Stable default', files: [{ path: 'index.html', content: 'same' }] }
    const created = await sites.createSite(owner, command)
    await sites.setOwnerSettings(owner, { defaultExpiresInSeconds: 86_400 })
    expect(await sites.createSite(owner, command)).toEqual(created)
    await expect(sites.createSite(owner, { ...command, files: [{ path: 'index.html', content: 'changed' }] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await sites.close(); sql.close()
  })

  it('resolves an omitted owner default at the creation commit boundary', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite')); const instant = new Date('2026-01-01T00:00:00Z')
    const active: { module?: SiteModule } = {}; let changeDefault = true
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, { now: () => instant,
      async fault(point) {
        if (changeDefault && point === 'after-finalize') {
          changeDefault = false
          if (!active.module) throw new Error('Site module is unavailable')
          await active.module.setOwnerSettings(owner, { defaultExpiresInSeconds: 86_400 })
        }
      },
    })
    active.module = module
    const created = await module.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Commit default', files: [{ path: 'index.html', content: 'one day' }],
    })
    expect(created.site.expiresAt).toBe('2026-01-02T00:00:00.000Z')
    await module.close(); reopened.close()
  })

  it('extends, shortens and removes a site expiration with version increments', async () => {
    let instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Mutable expiration', files: [{ path: 'index.html', content: 'temporary' }],
    })
    const extended = await sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, expiresInSeconds: 2_592_000,
    })
    expect(extended.site).toMatchObject({ version: 2, expiresAt: '2026-01-31T00:00:00.000Z' })
    instant = new Date('2026-01-01T00:01:00Z')
    const shortened = await sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 2, expiresInSeconds: 60,
    })
    expect(shortened.site).toMatchObject({ version: 3, expiresAt: '2026-01-01T00:02:00.000Z' })
    const removed = await sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 3, expiresInSeconds: null,
    })
    expect(removed.site).toMatchObject({ version: 4, expiresAt: null })
    await sites.close(); sql.close()
  })

  it('records a no-op expiration receipt without changing version or timestamps', async () => {
    const instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Same expiration', files: [{ path: 'index.html', content: 'unchanged' }],
    })
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, expiresInSeconds: 604_800 }
    const unchanged = await sites.setExpiration(owner, command)
    expect(unchanged.site).toMatchObject({ version: 1, updatedAt: created.site.updatedAt, expiresAt: created.site.expiresAt })
    expect(await sites.setExpiration(owner, command)).toEqual(unchanged)
    await sites.close(); sql.close()
  })

  it('orders expiration ownership, receipt, version and terminal lifecycle checks', async () => {
    let instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Expiration checks', expiresInSeconds: null, files: [{ path: 'index.html', content: 'live' }],
    })
    await expect(sites.setExpiration({ ownerId: 'other-owner' }, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, expiresInSeconds: 60,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 2, expiresInSeconds: 60,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 1 } })
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, expiresInSeconds: 60 }
    const shortened = await sites.setExpiration(owner, command)
    const removed = await sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 2, expiresInSeconds: null,
    })
    expect(await sites.setExpiration(owner, command)).toEqual(shortened)
    expect(await sites.getSite(owner, created.site.id)).toEqual(removed.site)
    const expiring = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Terminal', expiresInSeconds: 60, files: [{ path: 'index.html', content: 'ending' }],
    })
    instant = new Date('2026-01-01T00:01:01Z')
    await expect(sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: expiring.site.id, expectedVersion: 1, expiresInSeconds: null,
    })).rejects.toMatchObject({ code: 'SITE_EXPIRED' })
    const deletedSite = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Tombstone', expiresInSeconds: null, files: [{ path: 'index.html', content: 'deleted' }],
    })
    const deleted = await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: deletedSite.site.id, expectedVersion: 1 })
    await expect(sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: deletedSite.site.id, expectedVersion: deleted.version, expiresInSeconds: null,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await sites.close(); sql.close()
  })

  it('denies visitors after a site is shortened to the minimum expiration and the clock passes it', async () => {
    let instant = new Date('2026-01-01T00:00:00Z')
    const { sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Short-lived', expiresInSeconds: null, files: [{ path: 'index.html', content: 'briefly public' }],
    })
    const visible = await sites.setVisibility(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, visibility: 'public',
    })
    await sites.setExpiration(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: visible.site.version, expiresInSeconds: 60,
    })
    instant = new Date('2026-01-01T00:01:01Z')
    await expect(sites.acquireActiveRevision(created.site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await sites.close(); sql.close()
  })

  it('migrates owner settings into an existing site database without changing site expiration', async () => {
    const instant = new Date('2026-01-01T00:00:00Z')
    const { dataDir, sites, sql, owner } = await fixture({}, { now: () => instant })
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: 'Before settings', expiresInSeconds: 120, files: [{ path: 'index.html', content: 'preserved' }],
    })
    await sites.close()
    sql.exec("DROP TABLE owner_settings; DELETE FROM __migrations WHERE name='0004_owner_settings'")
    sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    const migrated = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, { now: () => instant })
    expect(await migrated.getOwnerSettings(owner)).toEqual({ defaultExpiresInSeconds: 604_800 })
    expect((await migrated.getSite(owner, created.site.id)).expiresAt).toBe(created.site.expiresAt)
    expect(reopened.prepare("SELECT name FROM __migrations WHERE name='0004_owner_settings'").get()).toEqual({ name: '0004_owner_settings' })
    await migrated.close(); reopened.close()
  })

  it('creates a private site and publishes an update at one stable identity', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, {
      operationId: crypto.randomUUID(), name: ' Example ',
      files: [{ path: 'index.html', content: 'first' }, { path: 'site.css', content: 'a{}' }],
    })
    expect(created.site).toMatchObject({ name: 'Example', visibility: 'private', version: 1, fileCount: 2 })
    const updated = await sites.writeFiles(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'index.html', content: 'second' }],
    })
    expect(updated.site).toMatchObject({ id: created.site.id, version: 2, visibility: 'private' })
    expect(updated.site.revisionId).not.toBe(created.site.revisionId)
    expect(await text(await sites.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' }))).toBe('second')
    expect(await text(await sites.openOwnedFile(owner, { siteId: created.site.id, path: 'site.css' }))).toBe('a{}')
    await sites.close(); sql.close()
  })

  it('returns a durable receipt and rejects reuse with different bytes', async () => {
    const { sites, sql, owner } = await fixture()
    const operationId = crypto.randomUUID()
    const command = { operationId, name: 'Retry', files: [{ path: 'index.html', content: 'same' }] }
    const first = await sites.createSite(owner, command)
    expect(await sites.createSite(owner, command)).toEqual(first)
    await expect(sites.createSite(owner, { ...command, files: [{ path: 'index.html', content: 'different' }] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await sites.close(); sql.close()
  })

  it('resolves a text create receipt before staging when stored capacity is full', async () => {
    const limits = { MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1' }
    const { dataDir, sites, sql, owner } = await fixture(limits)
    const operationId = crypto.randomUUID()
    const command = { operationId, name: 'Receipt A', files: [{ path: 'index.html', content: 'a'.repeat(400 * 1024) }] }
    const first = await sites.createSite(owner, command)
    await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Receipt B', files: [{ path: 'index.html', content: 'b'.repeat(300 * 1024) }] })
    await chmod(join(dataDir, 'staging'), 0o500)
    try {
      expect(await sites.createSite(owner, command)).toEqual(first)
      await expect(sites.createSite(owner, { ...command, files: [{ path: 'index.html', content: 'c'.repeat(400 * 1024) }] }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    } finally { await chmod(join(dataDir, 'staging'), 0o700) }
    await sites.close(); sql.close()
  })

  it('resolves a text write receipt before staging or version checks at full stored capacity', async () => {
    const limits = { MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1' }
    const { dataDir, sites, sql, owner } = await fixture(limits)
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Write A', files: [{ path: 'index.html', content: 'a'.repeat(300 * 1024) }] })
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'index.html', content: 'b'.repeat(300 * 1024) }] }
    const first = await sites.writeFiles(owner, command)
    await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Write B', files: [{ path: 'index.html', content: 'c'.repeat(150 * 1024) }] })
    await chmod(join(dataDir, 'staging'), 0o500)
    try {
      expect(await sites.writeFiles(owner, command)).toEqual(first)
      await expect(sites.writeFiles(owner, { ...command, files: [{ path: 'index.html', content: 'd'.repeat(300 * 1024) }] }))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    } finally { await chmod(join(dataDir, 'staging'), 0o700) }
    await sites.close(); sql.close()
  })

  it('keeps the old revision active when finalization fails', async () => {
    const { dataDir, sql, sites, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Atomic', files: [{ path: 'index.html', content: 'old' }] })
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopenedSql = new Database(join(dataDir, 'database.sqlite'))
    const failing = await createSiteModule(config, { sql: reopenedSql, close: () => reopenedSql.close() }, {
      fault(point) { if (point === 'after-finalize') throw new Error('simulated interruption') },
    })
    await expect(failing.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'new' }] })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await text(await failing.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' }))).toBe('old')
    await failing.close()
    expect(sql.open).toBe(false)
  })

  it('keeps metadata and quota reservations consistent after ENOSPC', async () => {
    const { dataDir, sql, sites, owner } = await fixture({ MAX_SITES: '1' })
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1', MAX_SITES: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    let fail = true
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      fault(point) {
        if (fail && point === 'before-revision-file-copy') {
          fail = false
          throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' })
        }
      },
    })
    await expect(module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Full', files: [{ path: 'index.html', content: 'first' }] }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', cause: { code: 'ENOSPC' } })
    expect(reopened.prepare('SELECT count(*) count FROM sites').get()).toEqual({ count: 0 })
    expect(await readdir(join(dataDir, 'staging'))).toEqual([])
    const created = await module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Recovered', files: [{ path: 'index.html', content: 'second' }] })
    expect(created.site).toMatchObject({ version: 1, sizeBytes: 6 })
    await module.close(); reopened.close()
  })

  it('preserves the original staging error and releases its reservation when cleanup also fails', async () => {
    const limits = { MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1' }
    const { dataDir, sites, sql, owner } = await fixture(limits)
    const stagingRoot = join(dataDir, 'staging')
    async function* brokenBody(): AsyncGenerator<Uint8Array> {
      await chmod(stagingRoot, 0o500)
      throw Object.assign(new Error('primary input failure'), { code: 'EIO' })
      yield new Uint8Array()
    }
    try {
      await expect(sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Reservation',
        files: [{ path: 'index.html', body: brokenBody(), maximumBytes: 400 * 1024 }] }))
        .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', cause: { code: 'EIO' } })
    } finally { await chmod(stagingRoot, 0o700) }
    expect((await readdir(stagingRoot)).length).toBeGreaterThan(0)
    await sites.runCleanup()
    expect(await readdir(stagingRoot)).toEqual([])
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Reservation', files: [{ path: 'index.html', content: 'a'.repeat(400 * 1024) }] })
    expect(created.site.sizeBytes).toBe(400 * 1024)
    await sites.close(); sql.close()
  })

  it('tracks an unpublished create revision when database failure cleanup is denied', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    let denyCleanup = true; let unpublishedRoot = ''
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      async fault(point) {
        if (denyCleanup && point === 'after-finalize') {
          const [siteId] = await readdir(join(dataDir, 'sites'))
          unpublishedRoot = join(dataDir, 'sites', siteId!, 'revisions')
          await chmod(unpublishedRoot, 0o500)
        }
      },
    })
    reopened.exec("CREATE TRIGGER fail_create_revision BEFORE INSERT ON site_revisions BEGIN SELECT RAISE(ABORT,'simulated database failure'); END")
    try {
      await expect(module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Database failure', files: [{ path: 'index.html', content: 'unpublished' }] }))
        .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    } finally { if (unpublishedRoot) await chmod(unpublishedRoot, 0o700) }
    await expect(module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Blocked', files: [{ path: 'index.html', content: 'blocked' }] }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(reopened.prepare('SELECT count(*) count FROM sites').get()).toEqual({ count: 0 })
    await module.runCleanup()
    expect(await readdir(join(dataDir, 'sites'))).toEqual([])
    reopened.exec('DROP TRIGGER fail_create_revision'); denyCleanup = false
    expect((await module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Recovered', files: [{ path: 'index.html', content: 'published' }] })).site.version).toBe(1)
    await module.close(); reopened.close()
  })

  it('tracks a finalized write revision when its database transaction fails', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Write failure', files: [{ path: 'index.html', content: 'old' }] })
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    const revisionsRoot = join(dataDir, 'sites', created.site.id, 'revisions'); let denyCleanup = true
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      async fault(point) { if (denyCleanup && point === 'after-finalize') await chmod(revisionsRoot, 0o500) },
    })
    reopened.exec(`CREATE TRIGGER fail_write_revision BEFORE INSERT ON site_revisions WHEN NEW.site_id='${created.site.id}' AND NEW.id<>'${created.site.revisionId}' BEGIN SELECT RAISE(ABORT,'simulated database failure'); END`)
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'new' }] }
    try { await expect(module.writeFiles(owner, command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }) }
    finally { await chmod(revisionsRoot, 0o700) }
    expect((await readdir(revisionsRoot)).length).toBe(2)
    await expect(module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Blocked', files: [{ path: 'index.html', content: 'blocked' }] }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await module.runCleanup()
    expect(await readdir(revisionsRoot)).toEqual([created.site.revisionId])
    reopened.exec('DROP TRIGGER fail_write_revision'); denyCleanup = false
    expect((await module.writeFiles(owner, command)).site.version).toBe(2)
    await module.close(); reopened.close()
  })

  it('tracks both roots of a delete-only revision interrupted after finalization', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Delete failure', files: [
      { path: 'index.html', content: 'keep' }, { path: 'remove.txt', content: 'remove' },
    ] })
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    const revisionsRoot = join(dataDir, 'sites', created.site.id, 'revisions'); let fail = true
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      async fault(point) {
        if (fail && point === 'after-finalize') {
          await chmod(revisionsRoot, 0o500)
          throw Object.assign(new Error('interrupted after finalization'), { code: 'EIO' })
        }
      },
    })
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, paths: ['remove.txt'] }
    try { await expect(module.deleteFiles(owner, command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', cause: { code: 'EIO' } }) }
    finally { await chmod(revisionsRoot, 0o700) }
    expect(await readdir(join(dataDir, 'staging'))).toEqual([])
    expect((await readdir(revisionsRoot)).length).toBe(2)
    await expect(module.deleteFiles(owner, command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await module.runCleanup()
    expect(await readdir(revisionsRoot)).toEqual([created.site.revisionId])
    fail = false
    expect((await module.deleteFiles(owner, command)).site.version).toBe(2)
    await module.close(); reopened.close()
  })

  it('records text and delete no-ops without reserving a full revision', async () => {
    const limits = { MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1' }
    const { sites, sql, owner } = await fixture(limits)
    const content = 'a'.repeat(300 * 1024)
    const first = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'No-op A', files: [{ path: 'index.html', content }] })
    await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'No-op B', files: [{ path: 'index.html', content: 'b'.repeat(300 * 1024) }] })
    await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'No-op C', files: [{ path: 'index.html', content: 'c'.repeat(150 * 1024) }] })
    const write = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: first.site.id, expectedVersion: 1, files: [{ path: 'index.html', content }] })
    expect(write).toMatchObject({ site: { version: 1 }, changedPaths: [], deletedPaths: [] })
    const deleted = await sites.deleteFiles(owner, { operationId: crypto.randomUUID(), siteId: first.site.id, expectedVersion: 1, paths: ['missing.txt'] })
    expect(deleted).toMatchObject({ site: { version: 1 }, changedPaths: [], deletedPaths: [] })
    await sites.close(); sql.close()
  })

  it('holds a retired revision while a reader lease is active', async () => {
    const { dataDir, sql, sites, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Lease', files: [{ path: 'index.html', content: 'old' }] })
    const lease = await sites.acquireActiveRevision(created.site.id)
    await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'new' }] })
    await sites.runCleanup()
    expect(await readFile(join(dataDir, 'sites', created.site.id, 'revisions', lease.revisionId, 'files', 'index.html'), 'utf8')).toBe('old')
    await lease.release()
    await sites.runCleanup()
    await expect(readFile(join(dataDir, 'sites', created.site.id, 'revisions', lease.revisionId, 'files', 'index.html'))).rejects.toThrow()
    await sites.close(); sql.close()
  })

  it('holds a retired revision while its file listing is in progress', async () => {
    const { dataDir, sql, sites, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Listing lease', files: [{ path: 'index.html', content: 'old' }] })
    await sites.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    let listingStarted!: () => void; let finishListing!: () => void; let delayListing = true
    const started = new Promise<void>((resolve) => { listingStarted = resolve })
    const finish = new Promise<void>((resolve) => { finishListing = resolve })
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      async fault(point) { if (delayListing && point === 'after-list-lease') { listingStarted(); await finish } },
    })
    await module.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'new' }] })
    const listing = module.listFiles(owner, { siteId: created.site.id, revisionId: created.site.revisionId })
    await started
    expect(await module.runCleanup()).toEqual({ removedRevisions: 0, removedSites: 0 })
    delayListing = false; finishListing()
    expect((await listing).files).toMatchObject([{ path: 'index.html' }])
    expect(await module.runCleanup()).toEqual({ removedRevisions: 1, removedSites: 0 })
    await expect(module.listFiles(owner, { siteId: created.site.id, revisionId: created.site.revisionId }))
      .rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
    await module.close(); reopened.close()
  })

  it('serves a retained revision manifest from memory and forgets it once reclaimed', async () => {
    const { dataDir, sql, sites, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Cached', files: [{ path: 'index.html', content: 'old' }, { path: 'a.css', content: 'a{}' }] })
    const first = await sites.listFiles(owner, { siteId: created.site.id })
    // The revision is immutable while retained, so later reads must not depend on disk.
    await rm(join(dataDir, 'sites', created.site.id, 'revisions', created.site.revisionId, 'manifest.json'))
    expect(await sites.listFiles(owner, { siteId: created.site.id, revisionId: created.site.revisionId })).toEqual(first)
    const lease = await sites.acquireActiveRevision(created.site.id)
    expect(lease.manifest).toEqual(first.files)
    await lease.release()
    await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'new' }] })
    expect(await sites.runCleanup()).toEqual({ removedRevisions: 1, removedSites: 0 })
    await expect(sites.listFiles(owner, { siteId: created.site.id, revisionId: created.site.revisionId })).rejects.toMatchObject({ code: 'REVISION_UNAVAILABLE' })
    await sites.close(); sql.close()
  })

  it('serializes competing versions and tombstones before cleanup', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Race', files: [{ path: 'index.html', content: 'one' }] })
    const outcomes = await Promise.allSettled(['two', 'three'].map((content) => sites.writeFiles(owner, {
      operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content }],
    })))
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } })
    const current = await sites.getSite(owner, created.site.id)
    const deleted = await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: current.id, expectedVersion: current.version })
    expect(deleted).toMatchObject({ deleted: true, cleanupPending: true, version: current.version + 1 })
    await expect(sites.getSite(owner, current.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await sites.close(); sql.close()
  })

  it('records no-op changes without advancing the site version', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'No-op', files: [{ path: 'index.html', content: 'same' }] })
    const write = await sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'same' }] })
    expect(write).toMatchObject({ site: { version: 1, revisionId: created.site.revisionId }, changedPaths: [], deletedPaths: [] })
    const removed = await sites.deleteFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, paths: ['missing.txt'] })
    expect(removed.site.version).toBe(1)
    await sites.close(); sql.close()
  })

  it('uses one deterministic path order across manifest pagination', async () => {
    const { sites, sql, owner } = await fixture()
    const paths = ['index.html', 'a.txt', '_asset.txt', 'z.txt', '0.txt', '-dash.txt', 'ä.txt']
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Paging',
      files: paths.map((path) => ({ path, content: path })) })
    const listed: string[] = []
    let cursor: string | undefined
    do {
      const page = await sites.listFiles(owner, { siteId: created.site.id, limit: 2, cursor })
      listed.push(...page.files.map((file) => file.path))
      cursor = page.cursor ?? undefined
    } while (cursor)
    expect(listed).toEqual(paths.slice().sort())
    await sites.close(); sql.close()
  })

  it('streams bytes into staging and rejects unsafe prospective trees', async () => {
    const { sites, sql, owner } = await fixture()
    async function* bytes() { yield new TextEncoder().encode('<h1>'); yield new TextEncoder().encode('Hello</h1>') }
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Stream', files: [{ path: 'index.html', body: bytes(), maximumBytes: 64 }] })
    expect(await text(await sites.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' }))).toBe('<h1>Hello</h1>')
    await expect(sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'assets/app.js', content: 'file' }, { path: 'assets/app.js/theme.css', content: 'code' }] })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: '../index.html', content: 'bad' }] })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await sites.close(); sql.close()
  })

  it('does not follow a symlink substituted into an active revision', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Symlink', files: [{ path: 'index.html', content: 'safe' }] })
    const file = join(dataDir, 'sites', created.site.id, 'revisions', created.site.revisionId, 'files', 'index.html')
    const outside = join(dataDir, 'outside.html')
    await writeFile(outside, 'outside')
    await rm(file)
    await symlink(outside, file)
    await expect(sites.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await expect(sites.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'site.css', content: 'body{}' }] })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await readFile(outside, 'utf8')).toBe('outside')
    expect((await sites.getSite(owner, created.site.id)).version).toBe(1)
    await sites.close(); sql.close()
  })

  it('releases a revision lease when an owned read path is invalid', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Invalid read', files: [{ path: 'index.html', content: 'safe' }] })
    await expect(sites.openOwnedFile(owner, { siteId: created.site.id, path: '../index.html' })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1 })
    expect(await sites.runCleanup()).toEqual({ removedRevisions: 0, removedSites: 1 })
    await expect(readdir(join(dataDir, 'sites', created.site.id))).rejects.toThrow()
    await sites.close(); sql.close()
  })

  it('keeps receipts after physical deletion and scopes all reads to the owner', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Private', files: [{ path: 'index.html', content: 'secret' }] })
    await expect(sites.getSite({ ownerId: 'other-owner' }, created.site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const command = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1 }
    const deleted = await sites.deleteSite(owner, command)
    await sites.runCleanup()
    expect(await sites.deleteSite(owner, command)).toEqual(deleted)
    await sites.close(); sql.close()
  })

  it('audits committed visibility and deletion changes once, excluding receipt replays', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { sites, sql, owner } = await fixture()
    try {
      const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Audit', files: [{ path: 'index.html', content: 'private' }] })
      const visibility = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, visibility: 'public' as const }
      const published = await sites.setVisibility(owner, visibility)
      await sites.setVisibility(owner, visibility)
      const deletion = { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: published.site.version }
      await sites.deleteSite(owner, deletion)
      await sites.deleteSite(owner, deletion)
      expect(info.mock.calls.map(([record]) => JSON.parse(String(record)))).toEqual([
        { event: 'site_visibility_changed', ownerId: owner.ownerId, siteId: created.site.id, operationId: visibility.operationId, visibility: 'public' },
        { event: 'site_deleted', ownerId: owner.ownerId, siteId: created.site.id, operationId: deletion.operationId },
      ])
    } finally { info.mockRestore(); await sites.close(); sql.close() }
  })

  it('rejects another owner before consuming a streamed body', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Owner', files: [{ path: 'index.html', content: 'secret' }] })
    let consumed = false
    async function* body() { consumed = true; yield new TextEncoder().encode('stolen') }
    await expect(sites.writeFiles({ ownerId: 'other-owner' }, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'index.html', body: body(), maximumBytes: 32 }] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(consumed).toBe(false)
    await sites.close(); sql.close()
  })

  it('denies an expired site before cleanup and reclaims it through the same tombstone path', async () => {
    const { dataDir, sql, owner } = await fixture()
    sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite')); let instant = new Date('2026-01-01T00:00:00Z')
    const sites = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, { now: () => instant })
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'TTL', expiresInSeconds: 60, files: [{ path: 'index.html', content: 'temporary' }] })
    instant = new Date('2026-01-01T00:01:01Z')
    await expect(sites.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' })).rejects.toMatchObject({ code: 'SITE_EXPIRED' })
    expect(await sites.runCleanup()).toMatchObject({ removedSites: 1 })
    await expect(sites.getSite(owner, created.site.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await sites.close(); reopened.close()
  })

  it('does not publish a revision when the site expires during finalization', async () => {
    const { dataDir, sql, owner } = await fixture()
    sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite')); let instant = new Date('2026-01-01T00:00:00Z'); let expireDuringFinalization = false
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, {
      now: () => instant,
      fault(point) { if (expireDuringFinalization && point === 'after-finalize') instant = new Date('2026-01-01T00:01:01Z') },
    })
    const created = await module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Expiring', expiresInSeconds: 60, files: [{ path: 'index.html', content: 'old' }] })
    expireDuringFinalization = true
    await expect(module.writeFiles(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'index.html', content: 'new' }] })).rejects.toMatchObject({ code: 'SITE_EXPIRED' })
    expect(reopened.prepare('SELECT version,active_revision_id FROM sites WHERE id=?').get(created.site.id))
      .toEqual({ version: 1, active_revision_id: created.site.revisionId })
    expect(await readdir(join(dataDir, 'sites', created.site.id, 'revisions'))).toEqual([created.site.revisionId])
    await module.close(); reopened.close()
  })

  it('backs off and retries physical cleanup after a real filesystem denial', async () => {
    const { dataDir, sql, owner } = await fixture()
    sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite')); let instant = new Date('2026-01-01T00:00:00Z')
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() }, { now: () => instant })
    const created = await module.createSite(owner, { operationId: crypto.randomUUID(), name: 'Cleanup', files: [{ path: 'index.html', content: 'delete me' }] })
    await module.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1 })
    const sitesRoot = join(dataDir, 'sites')
    await chmod(sitesRoot, 0o500)
    try {
      expect(await module.runCleanup(instant)).toEqual({ removedRevisions: 0, removedSites: 0 })
      expect(reopened.prepare('SELECT cleanup_attempts,cleanup_after_ms,cleanup_error_category FROM sites WHERE id=?').get(created.site.id))
        .toEqual({ cleanup_attempts: 1, cleanup_after_ms: instant.getTime() + 1000, cleanup_error_category: 'filesystem' })
    } finally { await chmod(sitesRoot, 0o700) }
    expect(await module.runCleanup(instant)).toEqual({ removedRevisions: 0, removedSites: 0 })
    instant = new Date(instant.getTime() + 1001)
    expect(await module.runCleanup(instant)).toEqual({ removedRevisions: 0, removedSites: 1 })
    await module.close(); reopened.close()
  })

  it('recovers an operation committed before its response and removes finalized orphans', async () => {
    const { dataDir, sites: initial, sql, owner } = await fixture()
    const created = await initial.createSite(owner, { operationId: crypto.randomUUID(), name: 'Recovery', files: [{ path: 'index.html', content: 'old' }] })
    await initial.close(); sql.close()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const operationId = crypto.randomUUID()
    const command = { operationId, siteId: created.site.id, expectedVersion: 1, files: [{ path: 'index.html', content: 'committed' }] }
    const interruptedDb = new Database(join(dataDir, 'database.sqlite'))
    const interrupted = await createSiteModule(config, { sql: interruptedDb, close: () => interruptedDb.close() }, {
      fault(point) { if (point === 'after-commit') throw new Error('response lost') },
    })
    await expect(interrupted.writeFiles(owner, command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await interrupted.close(); interruptedDb.close()
    const recoveredDb = new Database(join(dataDir, 'database.sqlite'))
    const recovered = await createSiteModule(config, { sql: recoveredDb, close: () => recoveredDb.close() })
    await recovered.recover()
    const replay = await recovered.writeFiles(owner, command)
    expect(replay.site).toMatchObject({ version: 2 })
    expect(await text(await recovered.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' }))).toBe('committed')
    expect(await readdir(join(dataDir, 'sites', created.site.id, 'revisions'))).toHaveLength(1)
    await recovered.close(); recoveredDb.close()
  })

  it('fails recovery when an active file has same-size content corruption', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Corrupt', files: [{ path: 'index.html', content: 'original' }] })
    await sites.close(); sql.close()
    await writeFile(join(dataDir, 'sites', created.site.id, 'revisions', created.site.revisionId, 'files', 'index.html'), 'tampered')
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const reopened = new Database(join(dataDir, 'database.sqlite'))
    const module = await createSiteModule(config, { sql: reopened, close: () => reopened.close() })
    await expect(module.recover()).rejects.toThrow('Active revision digest is inconsistent')
    await module.close(); reopened.close()
  })

  it('reserves the configured site-count quota across concurrent creations', async () => {
    const { sites, sql, owner } = await fixture({ MAX_SITES: '1' })
    const outcomes = await Promise.allSettled(['one', 'two'].map((name) => sites.createSite(owner, {
      operationId: crypto.randomUUID(), name, files: [{ path: 'index.html', content: name }],
    })))
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'QUOTA_EXCEEDED' } })
    await sites.close(); sql.close()
  })

  it('invalidates a lease snapshot when public visibility is revoked before streaming starts', async () => {
    const { sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Visibility', files: [{ path: 'index.html', content: 'private' }] })
    const published = await sites.setVisibility(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1, visibility: 'public' })
    const staleLease = await sites.acquireActiveRevision(created.site.id)
    expect(staleLease.site).toMatchObject({ visibility: 'public', visibilityGeneration: 1 })
    await sites.setVisibility(owner, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: published.site.version, visibility: 'private' })
    await expect(staleLease.open('index.html')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const currentLease = await sites.acquireActiveRevision(created.site.id)
    expect(currentLease.site).toMatchObject({ visibility: 'private', visibilityGeneration: 2 })
    await currentLease.release(); await sites.close(); sql.close()
  })

  it('cancels a stalled streamed mutation before close returns', async () => {
    const { sites, sql, owner } = await fixture()
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    async function* stalled() { started(); await new Promise(() => undefined); yield new Uint8Array() }
    const mutation = sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Shutdown', files: [{ path: 'index.html', body: stalled(), maximumBytes: 32 }] })
    const rejected = expect(mutation).rejects.toMatchObject({ code: 'BUSY' })
    await reading
    await sites.close()
    await rejected
    sql.close()
  })

  it('recovers a finalized orphan after an actual child-process interruption', async () => {
    const { dataDir, sites, sql, owner } = await fixture()
    const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Crash', files: [{ path: 'index.html', content: 'still active' }] })
    await sites.close(); sql.close()
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/sites/fixtures/crash-process.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AGENT_PAGES_CRASH_FIXTURE: JSON.stringify({ dataDir, ownerId: owner.ownerId, siteId: created.site.id, operationId: crypto.randomUUID() }) },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const [code, signal] = await once(child, 'exit')
    expect(code, stderr).toBe(91)
    expect(signal).toBeNull()
    const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
    const recoveredDb = new Database(join(dataDir, 'database.sqlite'))
    const recovered = await createSiteModule(config, { sql: recoveredDb, close: () => recoveredDb.close() })
    await recovered.recover()
    expect(await text(await recovered.openOwnedFile(owner, { siteId: created.site.id, path: 'index.html' }))).toBe('still active')
    expect(await readdir(join(dataDir, 'sites', created.site.id, 'revisions'))).toEqual([created.site.revisionId])
    await recovered.close(); recoveredDb.close()
  })
})
