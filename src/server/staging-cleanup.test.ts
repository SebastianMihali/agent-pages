import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { openDatabase } from './db'
import { createAuth } from './auth'
import { parseConfig } from './config'
import { createSiteModule } from './sites'

it('keeps failed staging reclamation bounded and accounted until cleanup succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-staging-cleanup-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`,
    MAX_FILE_SIZE_MB: '1', MAX_SITE_SIZE_MB: '1', MAX_TOTAL_SITE_SIZE_MB: '1', MAX_STORED_SIZE_MB: '1', MIN_FREE_DISK_MB: '1' })
  const auth = createAuth(db, config)
  let sabotage = true
  const sites = await createSiteModule(config, db, { fault: async (point) => {
    if (point === 'after-stage' && sabotage) { sabotage = false; await chmod(join(directory, 'staging'), 0o500) }
  } })
  try {
    const principal = { ownerId: auth.ownerId }
    const first = await sites.createSite(principal, { operationId: randomUUID(), name: 'First', files: [{ path: 'index.html', content: 'a'.repeat(400 * 1024) }] })
    expect(first.site.sizeBytes).toBe(400 * 1024)
    await chmod(join(directory, 'staging'), 0o700)
    const next = { operationId: randomUUID(), name: 'Next', files: [{ path: 'index.html', content: 'b'.repeat(300 * 1024) }] }
    await expect(sites.createSite(principal, next)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await sites.runCleanup()
    expect((await sites.createSite(principal, next)).site.sizeBytes).toBe(300 * 1024)
  } finally {
    await chmod(join(directory, 'staging'), 0o700)
    await sites.close(); db.close(); await rm(directory, { recursive: true, force: true })
  }
})
