import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createAccess } from './access'
import { createAuth } from './auth'
import { hashPassword } from './auth/password'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule, type SiteModuleOptions, type SiteView } from './sites'
import { createSitesWebHandler } from './web-sites'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(overrides: Record<string, string> = {}, options: SiteModuleOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-web-sites-'))
  roots.push(dataDir)
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: await hashPassword('test-only-password-123'), MIN_FREE_DISK_MB: '1', ...overrides })
  const db = openDatabase(dataDir)
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db, options)
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
  it('deletes with a session and CSRF, rejects stale versions, and replays the receipt', async () => {
    const { auth, csrfToken, db, send, sites, handle, config, cookie } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Delete me',
        files: [{ path: 'index.html', content: 'private' }] })
      const path = `/web/sites/${site.id}`
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1 }
      const key = auth.createKey({ ownerId: auth.ownerId }, 'Deletion').key
      const deniedHeaders: Record<string, string>[] = [{ origin: config.appOrigin }, { origin: config.appOrigin, authorization: `Bearer ${key}` },
        { cookie, origin: 'https://evil.sites.example.com' }, { cookie }]
      for (const headers of deniedHeaders) {
        expect((await handle(new Request(config.appOrigin + path, { method: 'DELETE', headers,
          body: JSON.stringify(command) })))!.status).toBe(401)
      }
      expect((await send(path, 'DELETE', { ...command, csrfToken: 'wrong' })).status).toBe(401)
      expect((await send(path + '?siteId=other', 'DELETE', command)).status).toBe(400)
      expect((await send(path, 'DELETE', { ...command, extra: true })).status).toBe(400)
      expect((await send(path, 'DELETE', { ...command, expectedVersion: 2 })).status).toBe(409)
      expect((await send(path)).status).toBe(200)
      const response = await send(path, 'DELETE', command)
      expect(response.status).toBe(200)
      const deleted = await response.json()
      expect(deleted).toMatchObject({ siteId: site.id, version: 2, deleted: true, cleanupPending: true })
      expect((await send(path)).status).toBe(404)
      expect((await (await send('/web/sites')).json()).sites).toEqual([])
      expect(await (await send(path, 'DELETE', command)).json()).toEqual(deleted)
    } finally { await sites.close(); db.close() }
  })

  it('gets and sets default expiration and changes a site expiration', async () => {
    const { auth, csrfToken, db, send, sites } = await fixture()
    expect(await (await send('/web/settings')).json()).toEqual({ defaultExpiresInSeconds: 604_800,
      limits: { maxFileBytes: 20 * 1024 * 1024, maxBatchFiles: 100, maxMultipartBodyBytes: 25 * 1024 * 1024,
        maxFilesPerSite: 500, maxSiteBytes: 50 * 1024 * 1024 } })
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

describe('owner dashboard and file editor', () => {
  it('aggregates all live owned sites beyond pagination and orders bounded recent and expiring lists', async () => {
    let instant = new Date('2026-01-01T00:00:00Z')
    const { auth, db, send, sites } = await fixture({ MAX_MUTATIONS_PER_MINUTE: '200' }, { now: () => instant })
    const owner = { ownerId: auth.ownerId }
    try {
      expect(await (await send('/web/overview')).json()).toEqual({ activeSites: 0, publicSites: 0, privateSites: 0,
        fileCount: 0, sizeBytes: 0, expiringSoon: 0, recentSites: [], expiringSites: [] })
      const live: SiteView[] = []
      for (let index = 0; index < 53; index += 1) {
        instant = new Date(instant.getTime() + 1000)
        const created = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: `Site ${index}`,
          expiresInSeconds: index < 7 ? 86_400 : null,
          files: [{ path: 'index.html', content: `page ${index}` }, { path: 'style.css', content: 'body{}' }] })
        live.push(created.site)
      }
      const published = await sites.setVisibility(owner, { siteId: live[0].id, operationId: crypto.randomUUID(), expectedVersion: 1, visibility: 'public' })
      live[0] = published.site
      const removed = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Deleted', expiresInSeconds: null,
        files: [{ path: 'index.html', content: 'excluded' }] })
      await sites.deleteSite(owner, { operationId: crypto.randomUUID(), siteId: removed.site.id, expectedVersion: 1 })
      await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Expired before cleanup', expiresInSeconds: 60,
        files: [{ path: 'index.html', content: 'excluded' }] })
      await sites.createSite({ ownerId: 'another-owner' }, { operationId: crypto.randomUUID(), name: 'Foreign', expiresInSeconds: null,
        files: [{ path: 'index.html', content: 'excluded' }] })
      instant = new Date(instant.getTime() + 60_000)
      expect((await sites.listSites(owner)).sites).toHaveLength(50)
      const response = await send('/web/overview')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const overview = await response.json()
      expect(overview).toMatchObject({ activeSites: 53, publicSites: 1, privateSites: 52, fileCount: 106,
        sizeBytes: live.reduce((sum, site) => sum + site.sizeBytes, 0), expiringSoon: 7 })
      const recent = [...live].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)).slice(0, 5)
      expect(overview.recentSites).toEqual(recent)
      expect(overview.expiringSites).toEqual(live.slice(0, 5))
      expect(await sites.getOverview({ ownerId: 'empty-owner' })).toMatchObject({ activeSites: 0, sizeBytes: 0, recentSites: [] })
    } finally { await sites.close(); db.close() }
  })

  it('requires an owner session and same-origin requests for overview and all file modes', async () => {
    const { auth, csrfToken, db, send, sites, handle, config, cookie } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Protected file',
        files: [{ path: 'index.html', content: 'private' }] })
      const path = `/web/sites/${site.id}/file`
      const key = auth.createKey({ ownerId: auth.ownerId }, 'API only').key
      const deniedHeaders: Record<string, string>[] = [{}, { authorization: `Bearer ${key}` },
        { cookie, origin: 'https://evil.sites.example.com' }, { cookie, 'sec-fetch-site': 'same-site' }, { cookie, 'sec-fetch-site': 'cross-site' }]
      for (const route of ['/web/overview', `${path}?path=index.html`, `${path}?path=index.html&mode=download`, `${path}?path=index.html&mode=preview`]) {
        for (const headers of deniedHeaders) {
          expect((await handle(new Request(config.appOrigin + route, { headers })))!.status).toBe(401)
        }
      }
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, path: 'index.html', content: 'edit' }
      for (const headers of [...deniedHeaders.map((headers) => ({ origin: config.appOrigin, ...headers })), { cookie }]) {
        expect((await handle(new Request(config.appOrigin + path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(command) })))!.status).toBe(401)
      }
      expect((await send(path, 'PUT', { ...command, csrfToken: 'wrong' })).status).toBe(401)
      const foreign = await sites.createSite({ ownerId: 'another-owner' }, { operationId: crypto.randomUUID(), name: 'Foreign',
        files: [{ path: 'index.html', content: 'other owner' }] })
      expect((await send(`/web/sites/${foreign.site.id}/file?path=index.html`)).status).toBe(404)
      expect((await send(`/web/sites/${foreign.site.id}/file`, 'PUT', command)).status).toBe(404)
      expect((await sites.getSite({ ownerId: auth.ownerId }, site.id)).version).toBe(1)
    } finally { await sites.close(); db.close() }
  })

  it('rejects ambiguous queries, traversal and unsupported methods without changing files', async () => {
    const { auth, csrfToken, db, send, sites } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Input boundaries',
        files: [{ path: 'index.html', content: 'unchanged' }] })
      const path = `/web/sites/${site.id}/file`
      for (const query of ['', '?path=index.html&path=index.html', '?path=index.html&mode=download&mode=preview',
        '?path=index.html&revisionId=' + site.revisionId, '?path=index.html&siteId=' + site.id, '?path=index.html&unknown=1', '?path=index.html&mode=execute']) {
        expect.soft((await send(path + query)).status, query).toBe(400)
      }
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, path: 'index.html', content: 'edit' }
      for (const unsafePath of ['../index.html', '/index.html', 'a/../../index.html', 'a\\index.html', '%2e%2e/index.html', '_agent/index.html', 'bad\u0000/index.html']) {
        expect((await send(`${path}?${new URLSearchParams({ path: unsafePath })}`)).status, unsafePath).toBe(400)
        expect((await send(path, 'PUT', { ...command, path: unsafePath })).status, unsafePath).toBe(400)
      }
      expect((await send(path + '?path=index.html', 'PUT', command)).status).toBe(400)
      expect((await send(path, 'PUT', { ...command, visibility: 'public' })).status).toBe(400)
      expect((await send('/web/overview?limit=50')).status).toBe(400)
      expect((await send('/web/overview?x=1&x=2')).status).toBe(400)
      for (const [route, allow] of [[path, 'GET, PUT'], ['/web/overview', 'GET']]) {
        const response = await send(route, 'POST')
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe(allow)
      }
      expect((await sites.getSite({ ownerId: auth.ownerId }, site.id)).version).toBe(1)
    } finally { await sites.close(); db.close() }
  })

  it('returns HTML and SVG as inert JSON and pins file bytes to the reported site version during publication', async () => {
    const { auth, db, send, sites } = await fixture()
    const owner = { ownerId: auth.ownerId }
    try {
      const html = '<script>window.stolen = document.cookie</script>'
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"/>'
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Inert source',
        files: [{ path: 'index.html', content: html }, { path: 'image.svg', content: svg }] })
      for (const [path, content] of [['index.html', html], ['image.svg', svg]]) {
        const response = await send(`/web/sites/${site.id}/file?${new URLSearchParams({ path })}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toMatchObject({ site, file: { path, sizeBytes: Buffer.byteLength(content) }, content, unavailableReason: null })
      }
      const openCurrentFile = sites.openCurrentFile.bind(sites)
      const publication = vi.spyOn(sites, 'openCurrentFile').mockImplementationOnce(async (principal, query) => {
        const before = await openCurrentFile(principal, query)
        await sites.writeFiles(owner, { siteId: query.siteId, operationId: crypto.randomUUID(), expectedVersion: 1,
          files: [{ path: 'index.html', content: 'newer publication' }] })
        expect(await sites.runCleanup()).toMatchObject({ removedRevisions: 0 })
        return before
      })
      const response = await send(`/web/sites/${site.id}/file?path=index.html`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ site: { version: 1, revisionId: site.revisionId }, content: html })
      expect(await sites.runCleanup()).toMatchObject({ removedRevisions: 1 })
      publication.mockRestore()
      expect((await sites.getSite(owner, site.id)).version).toBe(2)
    } finally { vi.restoreAllMocks(); await sites.close(); db.close() }
  })

  it('downloads exact bytes as attachments and permits only raster image previews', async () => {
    const { auth, db, send, sites } = await fixture()
    try {
      const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
      const html = '<script>alert(1)</script>'
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Downloads',
        files: [{ path: 'index.html', content: html }, { path: 'image.svg', content: '<svg/>' },
          { path: 'assets/picture.png', body: bytes, maximumBytes: bytes.length }, { path: 'font.woff2', body: bytes, maximumBytes: bytes.length }] })
      const path = `/web/sites/${site.id}/file`
      for (const [filePath, expected] of [['index.html', new TextEncoder().encode(html)], ['assets/picture.png', bytes]] as const) {
        const response = await send(`${path}?${new URLSearchParams({ path: filePath, mode: 'download' })}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/octet-stream')
        expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
        expect(response.headers.get('content-length')).toBe(String(expected.length))
        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected)
      }
      const preview = await send(`${path}?path=assets/picture.png&mode=preview`)
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-type')).toBe('image/png')
      expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
      expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes)
      for (const filePath of ['index.html', 'image.svg', 'font.woff2']) {
        expect((await send(`${path}?${new URLSearchParams({ path: filePath, mode: 'preview' })}`)).status).toBe(415)
      }
    } finally { await sites.close(); db.close() }
  })

  it('explains binary, invalid UTF-8 and oversized files without losing original bytes', async () => {
    const { auth, db, send, sites } = await fixture()
    try {
      const invalid = Uint8Array.from([0xc3, 0x28])
      const binary = Uint8Array.from([0, 255])
      const bomText = '\uFEFForiginal text\r\n'
      const oversized = 'é'.repeat(131_073)
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Read limitations',
        files: [{ path: 'index.html', content: 'home' }, { path: 'invalid.txt', body: invalid, maximumBytes: invalid.length },
          { path: 'font.woff2', body: binary, maximumBytes: binary.length }, { path: 'large.txt', content: oversized }, { path: 'bom.txt', content: bomText }] })
      const path = `/web/sites/${site.id}/file`
      for (const [filePath, reason, size] of [['invalid.txt', /UTF-8/, invalid.length], ['font.woff2', /binary/, binary.length],
        ['large.txt', /editor limit/, Buffer.byteLength(oversized)]] as const) {
        const response = await send(`${path}?${new URLSearchParams({ path: filePath })}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ content: null, unavailableReason: expect.stringMatching(reason), file: { sizeBytes: size } })
      }
      expect(await (await send(`${path}?path=bom.txt`)).json()).toMatchObject({ content: bomText, unavailableReason: null })
      expect(new Uint8Array(await (await send(`${path}?path=invalid.txt&mode=download`)).arrayBuffer())).toEqual(invalid)
    } finally { await sites.close(); db.close() }
  })

  it('publishes existing text files atomically, preserves visibility and replays saves without overwriting newer changes', async () => {
    let failPublication = false
    const { auth, csrfToken, db, send, sites } = await fixture({}, { fault(point) {
      if (failPublication && point === 'after-stage') throw new Error('Injected staging failure')
    } })
    const owner = { ownerId: auth.ownerId }
    try {
      const contents = { 'index.html': '<main>new</main>', 'style.css': 'body{color:red}', 'app.js': 'console.log("saved")',
        'data.json': '{"saved":true}', 'image.svg': '<svg/>', 'notes.txt': '\uFEFFhéllo\r\n' }
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Editor saves',
        files: Object.keys(contents).map((path) => ({ path, content: 'original' })) })
      await sites.setVisibility(owner, { operationId: crypto.randomUUID(), siteId: site.id, expectedVersion: 1, visibility: 'public' })
      const path = `/web/sites/${site.id}/file`
      let version = 2
      for (const [filePath, content] of Object.entries(contents)) {
        const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: version, path: filePath, content }
        const response = await send(path, 'PUT', command)
        expect(response.status).toBe(200)
        const receipt = await response.json()
        version += 1
        expect(receipt).toMatchObject({ site: { visibility: 'public', version, fileCount: 6 }, changedPaths: [filePath], deletedPaths: [] })
        expect(await (await send(path, 'PUT', command)).json()).toEqual(receipt)
        expect(await (await send(`${path}?${new URLSearchParams({ path: filePath })}`)).json()).toMatchObject({ content, site: { version, visibility: 'public' } })
      }
      const before = await sites.getSite(owner, site.id)
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: version, path: 'index.html', content: 'attempted edit' }
      failPublication = true
      expect((await send(path, 'PUT', command)).status).toBe(503)
      failPublication = false
      expect(await sites.getSite(owner, site.id)).toEqual(before)
      expect(await (await send(`${path}?path=index.html`)).json()).toMatchObject({ content: contents['index.html'] })
      expect((await send(path, 'PUT', command)).status).toBe(200)
      const conflict = await send(path, 'PUT', { ...command, operationId: crypto.randomUUID(), content: 'stale edit' })
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', details: { currentVersion: version + 1 } } })
      expect((await send(path, 'PUT', { ...command, content: 'different retry' })).status).toBe(409)
      expect(await (await send(`${path}?path=index.html`)).json()).toMatchObject({ content: 'attempted edit' })
      expect(await (await send(`${path}?path=style.css`)).json()).toMatchObject({ content: contents['style.css'] })
    } finally { await sites.close(); db.close() }
  })

  it('replays a successful save after an agent deletes the file without recreating it', async () => {
    const { auth, csrfToken, db, send, sites } = await fixture()
    const owner = { ownerId: auth.ownerId }
    try {
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Lost save response',
        files: [{ path: 'index.html', content: 'home' }, { path: 'notes.txt', content: 'original' }] })
      const path = `/web/sites/${site.id}/file`
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, path: 'notes.txt', content: 'saved' }
      const saved = await send(path, 'PUT', command)
      expect(saved.status).toBe(200)
      const receipt = await saved.json()
      const deleted = await sites.deleteFiles(owner, { operationId: crypto.randomUUID(), siteId: site.id,
        expectedVersion: 2, paths: ['notes.txt'] })
      const retry = await send(path, 'PUT', command)
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual(receipt)
      expect((await send(`${path}?path=notes.txt`)).status).toBe(404)
      expect((await send(path, 'PUT', { ...command, operationId: crypto.randomUUID(), expectedVersion: 3 })).status).toBe(404)
      expect(await sites.getSite(owner, site.id)).toEqual(deleted.site)
      expect(await (await send(`${path}?path=index.html`)).json()).toMatchObject({ content: 'home' })
    } finally { await sites.close(); db.close() }
  })

  it('rejects new paths, binary writes and text exceeding the byte limit without publishing a revision', async () => {
    const { auth, csrfToken, db, send, sites } = await fixture()
    const owner = { ownerId: auth.ownerId }
    try {
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Write limits',
        files: [{ path: 'index.html', content: 'original' }, { path: 'picture.png', body: new Uint8Array([0, 255]), maximumBytes: 2 }] })
      const path = `/web/sites/${site.id}/file`
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, path: 'index.html', content: 'replacement' }
      expect((await send(path, 'PUT', { ...command, path: 'new.txt' })).status).toBe(404)
      expect((await send(path, 'PUT', { ...command, path: 'picture.png' })).status).toBe(415)
      expect((await send(path, 'PUT', { ...command, content: 'é'.repeat(131_073) })).status).toBe(413)
      expect((await send(path, 'PUT', { ...command, content: [0, 255] })).status).toBe(400)
      expect(await sites.getSite(owner, site.id)).toEqual(site)
      expect(await (await send(`${path}?path=index.html`)).json()).toMatchObject({ content: 'original' })
    } finally { await sites.close(); db.close() }
  })
})

async function publicationRequest(config: { appOrigin: string }, cookie: string, csrfToken: string,
  path: string, manifest: Record<string, unknown>, files: Array<{ path: string; content: string | Uint8Array }>) {
  const form = new FormData()
  form.set('manifest', JSON.stringify({ ...manifest, files: files.map((file, index) => ({ path: file.path, partName: `file${index}` })) }))
  files.forEach((file, index) => form.append(`file${index}`, new Blob([typeof file.content === 'string' ? file.content : new Uint8Array(file.content)]), file.path))
  const method = path === '/web/sites' ? 'POST' : 'PUT'
  const encoded = new Request(config.appOrigin + path, { method, body: form })
  return new Request(encoded.url, { method, headers: { cookie, origin: config.appOrigin, 'sec-fetch-site': 'same-origin',
    'x-csrf-token': csrfToken, 'content-type': encoded.headers.get('content-type')! }, body: await encoded.arrayBuffer() })
}

describe('browser publication', () => {
  it('creates privately, merges files, deletes once and replays receipts without another revision', async () => {
    const { auth, csrfToken, db, send, sites, handle, config, cookie } = await fixture()
    const owner = { ownerId: auth.ownerId }
    try {
      const creation = { operationId: crypto.randomUUID(), name: 'Browser site', expiresInSeconds: null }
      const initial = [{ path: 'index.html', content: 'home' }, { path: 'keep.txt', content: 'keep me' }]
      const created = await handle(await publicationRequest(config, cookie, csrfToken, '/web/sites', creation, initial))
      expect(created!.status).toBe(201)
      const receipt = await created!.json()
      expect(receipt.site).toMatchObject({ name: 'Browser site', visibility: 'private', version: 1, expiresAt: null, fileCount: 2 })
      expect(await (await handle(await publicationRequest(config, cookie, csrfToken, '/web/sites', creation, initial)))!.json()).toEqual(receipt)
      expect((await sites.listSites(owner)).sites).toHaveLength(1)
      const { site } = receipt
      const path = `/web/sites/${site.id}/files`
      const update = { operationId: crypto.randomUUID(), expectedVersion: 1 }
      const selected = [{ path: 'index.html', content: 'new home' }, { path: 'docs/notes.md', content: '# Notes' },
        { path: 'guide.pdf', content: new Uint8Array([37, 80, 68, 70, 45, 0, 255]) }]
      const changed = await handle(await publicationRequest(config, cookie, csrfToken, path, update, selected))
      expect(changed!.status).toBe(200)
      const changedReceipt = await changed!.json()
      expect(changedReceipt).toMatchObject({ site: { version: 2, fileCount: 4, visibility: 'private' },
        changedPaths: ['docs/notes.md', 'guide.pdf', 'index.html'], deletedPaths: [] })
      expect(await (await handle(await publicationRequest(config, cookie, csrfToken, path, update, selected)))!.json()).toEqual(changedReceipt)
      const conflict = await handle(await publicationRequest(config, cookie, csrfToken, path,
        { ...update, operationId: crypto.randomUUID() }, selected))
      expect(conflict!.status).toBe(409)
      expect(await conflict!.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', details: { currentVersion: 2 } } })
      expect(await (await send(`/web/sites/${site.id}/file?path=keep.txt`)).json()).toMatchObject({ content: 'keep me' })
      for (const file of ['docs/notes.md', 'guide.pdf']) {
        expect(await (await send(`/web/sites/${site.id}/file?path=${file}`)).json()).toMatchObject({ content: null })
      }
      const deletion = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 2, paths: ['docs/notes.md'] }
      const deleted = await send(path + '/delete', 'POST', deletion)
      expect(deleted.status).toBe(200)
      const deletedReceipt = await deleted.json()
      expect(deletedReceipt).toMatchObject({ site: { version: 3, fileCount: 3 }, deletedPaths: ['docs/notes.md'] })
      expect(await (await send(path + '/delete', 'POST', deletion)).json()).toEqual(deletedReceipt)
      expect((await send(path + '/delete', 'POST', { ...deletion, operationId: crypto.randomUUID() })).status).toBe(409)
      const rootDeletion = await send(path + '/delete', 'POST', { ...deletion, operationId: crypto.randomUUID(), expectedVersion: 3, paths: ['index.html'] })
      expect(rootDeletion.status).toBe(400)
      expect(await rootDeletion.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
      expect((await sites.getSite(owner, site.id)).version).toBe(3)
    } finally { await sites.close(); db.close() }
  })
})

describe('browser publication request protection', () => {
  it('rejects bad credentials, origins, metadata, queries and media before reading multipart bodies', async () => {
    const { auth, csrfToken, db, sites, handle, config, cookie } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Protected',
        files: [{ path: 'index.html', content: 'original' }] })
      const key = auth.createKey({ ownerId: auth.ownerId }, 'Bearer rejected').key
      for (const [path, method] of [['/web/sites', 'POST'], [`/web/sites/${site.id}/files`, 'PUT']]) {
        const defaults = { cookie, origin: config.appOrigin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken,
          'content-type': 'multipart/form-data; boundary=fixture' }
        const cases: Array<{ headers?: Record<string, string | null>; query?: string; status: number }> = [
          { headers: { 'x-csrf-token': null }, status: 401 }, { headers: { 'x-csrf-token': 'wrong' }, status: 401 },
          { headers: { origin: null }, status: 401 }, { headers: { origin: 'https://evil.sites.example.com' }, status: 401 },
          { headers: { 'sec-fetch-site': 'same-site' }, status: 401 }, { headers: { 'sec-fetch-site': 'cross-site' }, status: 401 },
          { headers: { cookie: null }, status: 401 }, { headers: { cookie: null, authorization: `Bearer ${key}` }, status: 401 },
          { headers: { authorization: `Bearer ${key}` }, status: 401 },
          { query: '?siteId=other', status: 400 }, { query: '?x=1&x=2', status: 400 },
          { headers: { 'content-type': 'application/json' }, status: 415 },
        ]
        for (const entry of cases) {
          const headers = new Headers(defaults)
          for (const [name, value] of Object.entries(entry.headers ?? {})) {
            if (value === null) headers.delete(name)
            else headers.set(name, value)
          }
          let reads = 0
          const body = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1; controller.close() } }, { highWaterMark: 0 })
          const request = new Request(config.appOrigin + path + (entry.query ?? ''), { method, headers, body, duplex: 'half' } as RequestInit)
          expect((await handle(request))!.status, JSON.stringify(entry)).toBe(entry.status)
          expect(reads).toBe(0)
          await body.cancel()
        }
      }
      expect((await sites.getSite({ ownerId: auth.ownerId }, site.id)).version).toBe(1)
    } finally { await sites.close(); db.close() }
  })

  it('protects JSON file deletion and scopes publication to the session owner', async () => {
    const { auth, csrfToken, db, sites, handle, send, config, cookie } = await fixture()
    try {
      const { site } = await sites.createSite({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), name: 'Protected deletion',
        files: [{ path: 'index.html', content: 'home' }, { path: 'notes.txt', content: 'keep' }] })
      const path = `/web/sites/${site.id}/files/delete`
      const command = { csrfToken, operationId: crypto.randomUUID(), expectedVersion: 1, paths: ['notes.txt'] }
      const key = auth.createKey({ ownerId: auth.ownerId }, 'Deletion bearer').key
      const denied: Record<string, string>[] = [{ origin: config.appOrigin }, { cookie },
        { origin: config.appOrigin, authorization: `Bearer ${key}` },
        { cookie, origin: config.appOrigin, authorization: `Bearer ${key}` },
        { cookie, origin: 'https://evil.sites.example.com' }, { cookie, origin: config.appOrigin, 'sec-fetch-site': 'same-site' },
        { cookie, origin: config.appOrigin, 'sec-fetch-site': 'cross-site' }]
      for (const headers of denied) {
        let reads = 0
        const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.close() } }, { highWaterMark: 0 })
        const request = new Request(config.appOrigin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit)
        expect((await handle(request))!.status).toBe(401)
        expect(reads).toBe(0)
        await body.cancel()
      }
      expect((await send(path, 'POST', { ...command, csrfToken: 'wrong' })).status).toBe(401)
      expect((await send(path, 'POST', { ...command, csrfToken: undefined })).status).toBe(400)
      expect((await send(path + '?path=notes.txt', 'POST', command)).status).toBe(400)
      expect((await send(path, 'POST', { ...command, unknown: true })).status).toBe(400)
      expect((await send(path, 'GET')).status).toBe(405)
      const foreign = await sites.createSite({ ownerId: 'other-owner' }, { operationId: crypto.randomUUID(), name: 'Foreign',
        files: [{ path: 'index.html', content: 'foreign' }, { path: 'notes.txt', content: 'private' }] })
      expect((await send(`/web/sites/${foreign.site.id}/files/delete`, 'POST', command)).status).toBe(404)
      expect((await handle(await publicationRequest(config, cookie, csrfToken, `/web/sites/${foreign.site.id}/files`,
        { operationId: crypto.randomUUID(), expectedVersion: 1 }, [{ path: 'notes.txt', content: 'attempt' }])))!.status).toBe(404)
      expect((await sites.getSite({ ownerId: auth.ownerId }, site.id)).version).toBe(1)
    } finally { await sites.close(); db.close() }
  })
})

describe('browser publication atomicity', () => {
  it('preserves the active revision when an upload is interrupted before the closing boundary', async () => {
    const { auth, csrfToken, db, sites, handle, config, cookie } = await fixture()
    try {
      const owner = { ownerId: auth.ownerId }
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Interrupted upload',
        files: [{ path: 'index.html', content: 'original' }] })
      const manifest = { operationId: crypto.randomUUID(), expectedVersion: 1, files: [{ path: 'index.html', partName: 'home' }] }
      const partial = new TextEncoder().encode(`--fixture\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n--fixture\r\nContent-Disposition: form-data; name="home"; filename="index.html"\r\nContent-Type: text/html\r\n\r\npartial content`)
      const controller = new AbortController()
      let cancelled = false
      let started!: () => void
      const reading = new Promise<void>((resolve) => { started = resolve })
      const request = new Request(`${config.appOrigin}/web/sites/${site.id}/files`, { method: 'PUT', signal: controller.signal,
        headers: { cookie, origin: config.appOrigin, 'x-csrf-token': csrfToken, 'content-type': 'multipart/form-data; boundary=fixture' },
        body: new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(partial) }, pull() { started() }, cancel() { cancelled = true } }), duplex: 'half' } as RequestInit)
      const response = handle(request)
      await reading
      controller.abort()
      expect((await response)!.status).toBe(400)
      expect(cancelled).toBe(true)
      expect(await sites.getSite(owner, site.id)).toEqual(site)
      expect(await new Response((await sites.openOwnedFile(owner, { siteId: site.id, path: 'index.html' })).body).text()).toBe('original')
    } finally { await sites.close(); db.close() }
  })

  it('preserves files on a preparation failure and permits the same operation to succeed afterward', async () => {
    let fail = false
    const { auth, csrfToken, db, sites, handle, config, cookie } = await fixture({}, { fault(point) {
      if (fail && point === 'after-stage') throw new Error('Injected publication failure')
    } })
    try {
      const owner = { ownerId: auth.ownerId }
      const { site } = await sites.createSite(owner, { operationId: crypto.randomUUID(), name: 'Failed upload',
        files: [{ path: 'index.html', content: 'original' }] })
      const manifest = { operationId: crypto.randomUUID(), expectedVersion: 1 }
      const files = [{ path: 'index.html', content: 'replacement' }]
      const path = `/web/sites/${site.id}/files`
      fail = true
      expect((await handle(await publicationRequest(config, cookie, csrfToken, path, manifest, files)))!.status).toBe(503)
      expect(await sites.getSite(owner, site.id)).toEqual(site)
      fail = false
      expect((await handle(await publicationRequest(config, cookie, csrfToken, path, manifest, files)))!.status).toBe(200)
      expect((await sites.getSite(owner, site.id)).version).toBe(2)
    } finally { await sites.close(); db.close() }
  })

  it('surfaces missing root and site quota errors without creating partial sites', async () => {
    const { auth, csrfToken, db, sites, handle, config, cookie } = await fixture({ MAX_SITES: '1' })
    try {
      const missing = await handle(await publicationRequest(config, cookie, csrfToken, '/web/sites',
        { operationId: crypto.randomUUID(), name: 'Missing index' }, [{ path: 'folder/index.html', content: 'nested' }]))
      expect(missing!.status).toBe(400)
      expect(await missing!.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('index.html') } })
      expect((await sites.listSites({ ownerId: auth.ownerId })).sites).toHaveLength(0)
      const first = await handle(await publicationRequest(config, cookie, csrfToken, '/web/sites',
        { operationId: crypto.randomUUID(), name: 'First' }, [{ path: 'index.html', content: 'home' }]))
      expect(first!.status).toBe(201)
      const second = await handle(await publicationRequest(config, cookie, csrfToken, '/web/sites',
        { operationId: crypto.randomUUID(), name: 'Second' }, [{ path: 'index.html', content: 'home' }]))
      expect(second!.status).toBe(409)
      expect(await second!.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
      expect((await sites.listSites({ ownerId: auth.ownerId })).sites).toHaveLength(1)
    } finally { await sites.close(); db.close() }
  })
})
