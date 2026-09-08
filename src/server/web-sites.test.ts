import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { createAccess } from './access'
import { createAuth } from './auth'
import { hashPassword } from './auth/password'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule } from './sites'
import { createSitesWebHandler } from './web-sites'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-web-sites-'))
  roots.push(dataDir)
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: await hashPassword('test-only-password-123'), MIN_FREE_DISK_MB: '1' })
  const db = openDatabase(dataDir)
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  const access = createAccess(db, auth, sites)
  const challenge = auth.createLoginChallenge()
  const login = await auth.login({ username: 'owner', password: 'test-only-password-123', challengeToken: challenge.token,
    csrfToken: challenge.csrfToken, ip: 'installation' })
  const cookie = `__Host-agp-session=${login.token}`
  const handle = createSitesWebHandler(config, auth, sites, access)
  const send = async (path: string, method = 'GET', body?: unknown) => {
    const response = await handle(new Request(`${config.appOrigin}${path}`, { method, headers: {
      cookie, ...(method === 'GET' ? {} : { origin: config.appOrigin }), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    if (!response) throw new Error('Expected a web response')
    return response
  }
  return { auth, csrfToken: login.session.csrfToken, db, send, sites, handle, config, cookie }
}

describe('owner site web operations', () => {
  it('downloads a ZIP with the owner session and rejects foreign requests and bearer-only access', async () => {
    const { auth, db, send, sites, handle, config, cookie } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Web ZIP',
        files: [{ path: 'index.html', content: 'owner download' }] })
      const path = `/web/sites/${site.id}/export`
      const response = await send(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="site-${site.id}.zip"`)
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
      expect(new TextDecoder().decode(entries['index.html'])).toBe('owner download')
      const key = auth.createKey({ ownerId: auth.ownerId }, 'Web boundary').key
      const deniedHeaders: Record<string, string>[] = [{}, { authorization: `Bearer ${key}` },
        { cookie, origin: 'https://evil.sites.example.com' }, { cookie, 'sec-fetch-site': 'same-site' },
        { cookie, 'sec-fetch-site': 'cross-site' }]
      for (const headers of deniedHeaders) {
        expect((await handle(new Request(config.appOrigin + path, { headers })))!.status).toBe(401)
      }
      expect((await send(path + '?revisionId=other')).status).toBe(400)
      expect((await send(path + '?x=1&x=2')).status).toBe(400)
      const wrongMethod = await send(path, 'POST')
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
      const head = await handle(new Request(config.appOrigin + path, { method: 'HEAD', headers: { cookie, 'sec-fetch-site': 'same-origin' } }))
      expect(head!.status).toBe(405)
      expect(head!.headers.get('allow')).toBe('GET')
      const download = await send(path)
      const restDownload = await sites.exportSite({ ownerId: auth.ownerId }, site.id)
      expect((await send(path)).status).toBe(503)
      await download.body!.cancel()
      await restDownload.body.cancel()
    } finally { await sites.close(); db.close() }
  })
  it('gets and sets default expiration and changes a site expiration', async () => {
    const { auth, csrfToken, db, send, sites } = await fixture()
    expect(await (await send('/web/settings')).json()).toEqual({ defaultExpiresInSeconds: 604_800 })
    const settings = await send('/web/settings', 'POST', { csrfToken, defaultExpiresInSeconds: 86_400 })
    expect(settings.status).toBe(200)
    expect(await settings.json()).toEqual({ defaultExpiresInSeconds: 86_400 })
    expect((await send('/web/settings', 'POST', { csrfToken, defaultExpiresInSeconds: 60 })).status).toBe(400)
    expect((await send('/web/settings', 'POST', { csrfToken, defaultExpiresInSeconds: null, unexpected: true })).status).toBe(400)

    const created = await sites.createSite({ ownerId: auth.ownerId }, {
      operationId: crypto.randomUUID(), name: 'Web expiration', expiresInSeconds: null, files: [{ path: 'index.html', content: 'live' }],
    })
    const changed = await send(`/web/sites/${created.site.id}/expiration`, 'POST', {
      csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, expiresInSeconds: 2_592_000,
    })
    expect(changed.status).toBe(200)
    expect((await changed.json()).site).toMatchObject({ version: 2 })
    const conflict = await send(`/web/sites/${created.site.id}/expiration`, 'POST', {
      csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, expiresInSeconds: null,
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', details: { currentVersion: 2 } } })
    await sites.close(); db.close()
  })
})
