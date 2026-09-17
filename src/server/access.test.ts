import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAuth } from './auth'
import { hashPassword } from './auth/password'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule } from './sites'
import { createAccess } from './access'

it('binds one-use tickets and grants to the site, parent session and visibility generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-access-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: await hashPassword('fixture-password') })
  let timestamp = Date.now()
  const auth = createAuth(db, config, { now: () => timestamp })
  const sites = await createSiteModule(config, db)
  try {
    const challenge = auth.createLoginChallenge()
    const login = await auth.login({ username: 'owner', password: 'fixture-password', challengeToken: challenge.token,
      csrfToken: challenge.csrfToken, ip: 'fixture' })
    const access = createAccess(db, auth, sites, () => timestamp)
    const { site } = await sites.createSite(login.session, { operationId: randomUUID(), name: 'Private', files: [{ path: 'index.html', content: 'secret' }] })
    const ticket = await access.issue(login.session, site.id, '/nested/?q=hello')
    await expect(access.redeem(ticket, 'f'.repeat(32))).rejects.toThrow()
    const grant = await access.redeem(ticket, site.id)
    expect(grant.returnPath).toBe('/nested/?q=hello')
    await expect(access.redeem(ticket, site.id)).rejects.toThrow()
    const expiringTicket = await access.issue(login.session, site.id, '/')
    timestamp += 60_001
    await expect(access.redeem(expiringTicket, site.id)).rejects.toThrow()
    for (let index = 0; index < 20; index++) await access.issue(login.session, site.id, '/')
    await expect(access.issue(login.session, site.id, '/')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    timestamp += 60_001
    access.sweepExpired()
    const lease = await sites.acquireActiveRevision(site.id)
    expect(access.permits(grant.token, lease.site)).toBe(true)
    expect(access.permits(grant.token, { ...lease.site, id: 'f'.repeat(32) })).toBe(false)
    expect(access.permits(grant.token, { ...lease.site, ownerId: 'another-owner' })).toBe(false)
    expect(access.permits(null, lease.site)).toBe(false)
    await lease.release()
    let currentGrant = grant
    for (let index = 0; index < 101; index++) currentGrant = await access.redeem(await access.issue(login.session, site.id, '/'), site.id)
    const reopenedLease = await sites.acquireActiveRevision(site.id)
    expect(access.permits(currentGrant.token, reopenedLease.site)).toBe(true)
    expect(access.permits(grant.token, reopenedLease.site)).toBe(false)
    expect(db.sql.prepare('SELECT COUNT(*) AS count FROM site_grants').get()).toEqual({ count: 1 })
    await reopenedLease.release()
    const published = await sites.setVisibility(login.session, { siteId: site.id, operationId: randomUUID(), expectedVersion: 1, visibility: 'public' })
    await sites.setVisibility(login.session, { siteId: site.id, operationId: randomUUID(), expectedVersion: published.site.version, visibility: 'private' })
    const privateLease = await sites.acquireActiveRevision(site.id)
    expect(access.permits(currentGrant.token, privateLease.site)).toBe(false)
    await privateLease.release()
    const fresh = await access.redeem(await access.issue(login.session, site.id, '/'), site.id)
    auth.logout(login.token)
    const finalLease = await sites.acquireActiveRevision(site.id)
    expect(access.permits(fresh.token, finalLease.site)).toBe(false)
    await finalLease.release()
    await expect(access.issue(login.session, site.id, '//outside.example')).rejects.toThrow()
    expect(JSON.stringify(db.sql.prepare('SELECT * FROM site_grants').all())).not.toContain(fresh.token)
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})
