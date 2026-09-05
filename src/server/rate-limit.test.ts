import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { openDatabase } from './db'
import { createAuth } from './auth'
import { parseConfig } from './config'
import { createSiteModule } from './sites'

it('shares one owner mutation budget across operations and rejects before consuming file streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-mutation-rate-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}`, MAX_MUTATIONS_PER_MINUTE: '1' })
  const auth = createAuth(db, config)
  let now = new Date()
  const sites = await createSiteModule(config, db, { now: () => now })
  try {
    const principal = { ownerId: auth.ownerId }
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Rate fixture', files: [{ path: 'index.html', content: 'before' }] })
    let consumed = false
    const command = { siteId: site.id, expectedVersion: 1, operationId: randomUUID(), files: [{ path: 'index.html', maximumBytes: 5,
      body: (async function* () { consumed = true; yield Buffer.from('after') })() }] }
    await expect(sites.writeFiles({ ownerId: auth.ownerId }, command)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(consumed).toBe(false)
    expect((await sites.getSite(principal, site.id)).version).toBe(1)
    now = new Date(now.getTime() + 60_001)
    expect((await sites.writeFiles(principal, command)).site.version).toBe(2)
    expect(consumed).toBe(true)
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})
