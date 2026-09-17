import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { createAuth } from './auth'
import { createApiHandler } from './api'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule } from './sites'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0)) await close() })

async function multipartRequest(url: string, key: string, form: FormData) {
  const encoded = new Request(url, { method: 'PUT', body: form })
  // Model an incoming HTTP body, rather than Undici's client-side FormData encoder.
  return new Request(url, { method: 'PUT', headers: { authorization: `Bearer ${key}`,
    'content-type': encoded.headers.get('content-type')! }, body: await encoded.arrayBuffer() })
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-api-'))
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: dataDir, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1' })
  const db = openDatabase(dataDir)
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  dispose.push(async () => { await sites.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
  const key = auth.createKey({ ownerId: auth.ownerId }, 'Fixture').key
  const handle = createApiHandler(config, auth, sites)
  const send = async (path: string, method = 'GET', body?: unknown) => {
    const response = await handle(new Request(`${config.appOrigin}${path}`, { method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    if (!response) throw new Error('Expected an API response')
    return response
  }
  return { config, auth, sites, key, handle, send }
}

describe('authenticated REST site operations', () => {
  it('exports a private site as a bearer-only ZIP attachment with safe headers', async () => {
    const { send, handle, config, key, auth } = await fixture()
    const { site } = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Unsafe " filename',
      files: [{ path: 'index.html', content: 'private export' }] })).json()
    const path = `/api/sites/${site.id}/export`
    const response = await send(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="site-${site.id}.zip"`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('x-agent-pages-revision')).toBe(site.revisionId)
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(new TextDecoder().decode(entries['index.html'])).toBe('private export')
    for (const suffix of ['?revisionId=other', '?ownerId=other', '?x=1&x=2']) expect((await send(path + suffix)).status).toBe(400)
    for (const method of ['POST', 'PUT', 'HEAD', 'DELETE']) {
      const wrongMethod = await send(path, method)
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('allow')).toBe('GET')
    }
    const deniedHeaders: Record<string, string>[] = [{}, { cookie: '__Host-agp-session=fixture' }, { authorization: `Bearer ${key}`, origin: 'https://evil.sites.example.com' }]
    for (const headers of deniedHeaders) {
      expect((await handle(new Request(config.appOrigin + path, { headers })))!.status).toBe(401)
    }
    auth.revokeKey({ ownerId: auth.ownerId }, auth.listKeys({ ownerId: auth.ownerId })[0].id)
    expect((await send(path)).status).toBe(401)
  })
  it('creates a private site and reads its metadata and raw bytes through bearer-authenticated routes', async () => {
    const { send } = await fixture()
    const response = await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'REST fixture',
      files: [{ path: 'index.html', content: '<h1>Private</h1>' }] })
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(created.site).toMatchObject({ visibility: 'private', version: 1 })
    expect((await (await send('/api/sites')).json()).sites).toEqual([created.site])
    expect(await (await send(`/api/sites/${created.site.id}`)).json()).toEqual(created.site)
    const file = await send(`/api/sites/${created.site.id}/file?path=index.html`)
    expect(file.headers.get('cache-control')).toBe('no-store')
    expect(file.headers.get('content-type')).toContain('text/html')
    expect(await file.text()).toBe('<h1>Private</h1>')
  })

  it('writes and lists files, changes visibility explicitly and retries deletion after cleanup', async () => {
    const { send, sites } = await fixture()
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Lifecycle',
      files: [{ path: 'index.html', content: 'one' }] })).json()
    const base = `/api/sites/${created.site.id}`
    const write = await send(`${base}/files`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 1,
      files: [{ path: 'index.html', content: 'two' }, { path: 'site.css', content: 'body{}' }] })
    expect(write.status).toBe(200)
    expect((await write.json()).site).toMatchObject({ visibility: 'private', version: 2 })
    const listing = await (await send(`${base}/files?limit=1`)).json()
    expect(listing.files).toHaveLength(1)
    expect((await (await send(`${base}/files?limit=1&revisionId=${listing.revisionId}&cursor=${encodeURIComponent(listing.cursor)}`)).json()).files)
      .toEqual([expect.objectContaining({ path: 'site.css' })])
    const removed = await (await send(`${base}/files/delete`, 'POST', { operationId: crypto.randomUUID(), expectedVersion: 2, paths: ['site.css'] })).json()
    expect(removed.deletedPaths).toEqual(['site.css'])
    const visible = await (await send(`${base}/visibility`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 3, visibility: 'public' })).json()
    expect(visible.site).toMatchObject({ visibility: 'public', version: 4 })
    const command = { operationId: crypto.randomUUID(), expectedVersion: 4 }
    const deleted = await (await send(base, 'DELETE', command)).json()
    expect(deleted.deleted).toBe(true)
    await sites.runCleanup()
    expect(await (await send(base, 'DELETE', command)).json()).toEqual(deleted)
  })

  it('changes expiration with optimistic concurrency and rejects invalid input', async () => {
    const { send } = await fixture()
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Expiration route',
      expiresInSeconds: null, files: [{ path: 'index.html', content: 'live' }] })).json()
    const endpoint = `/api/sites/${created.site.id}/expiration`
    const changed = await send(endpoint, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 1, expiresInSeconds: 86_400 })
    expect(changed.status).toBe(200)
    expect((await changed.json()).site).toMatchObject({ version: 2 })
    const conflict = await send(endpoint, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 1, expiresInSeconds: null })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', details: { currentVersion: 2 } } })
    for (const body of [
      { operationId: crypto.randomUUID(), expectedVersion: 2, expiresInSeconds: 59 },
      { operationId: crypto.randomUUID(), expectedVersion: 2, expiresInSeconds: null, unexpected: true },
    ]) expect((await send(endpoint, 'PUT', body)).status).toBe(400)
    const wrongMethod = await send(endpoint, 'POST', {})
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('PUT')
  })

  it('streams manifest-ordered text and binary multipart parts into one private publication', async () => {
    const { send, handle, config, key } = await fixture()
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Multipart',
      files: [{ path: 'index.html', content: 'old' }] })).json()
    const form = new FormData()
    form.append('manifest', JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 1,
      files: [{ path: 'index.html', partName: 'page' }, { path: 'image.png', partName: 'image' }] }))
    form.append('page', new Blob(['new page']), 'untrusted.html')
    form.append('image', new Blob([new Uint8Array([137, 80, 78, 71])]), '../untrusted.png')
    const response = await handle(await multipartRequest(`${config.appOrigin}/api/sites/${created.site.id}/files`, key, form))
    expect(response!.status).toBe(200)
    expect((await response!.json()).site).toMatchObject({ visibility: 'private', version: 2, fileCount: 2 })
    expect(await (await send(`/api/sites/${created.site.id}/file?path=index.html`)).text()).toBe('new page')
    expect(new Uint8Array(await (await send(`/api/sites/${created.site.id}/file?path=image.png`)).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it.each(['duplicate', 'missing', 'out-of-order', 'extra-field'])('rejects %s multipart parts before publication', async (kind) => {
    const { send, handle, config, key } = await fixture()
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Atomic multipart',
      files: [{ path: 'index.html', content: 'old' }] })).json()
    const form = new FormData()
    form.append('manifest', JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 1,
      files: [{ path: 'index.html', partName: 'page' }, { path: 'image.png', partName: 'image' }] }))
    if (kind === 'out-of-order') form.append('image', new Blob(['image']), 'image.png')
    form.append('page', new Blob(['must not publish']), 'index.html')
    if (kind !== 'missing' && kind !== 'out-of-order') form.append('image', new Blob(['image']), 'image.png')
    if (kind === 'duplicate') form.append('page', new Blob(['duplicate']), 'index.html')
    if (kind === 'extra-field') form.append('unexpected', 'ignored?')
    const response = await handle(await multipartRequest(`${config.appOrigin}/api/sites/${created.site.id}/files`, key, form))
    expect(response!.status).toBe(400)
    expect((await (await send(`/api/sites/${created.site.id}`)).json()).version).toBe(1)
    expect(await (await send(`/api/sites/${created.site.id}/file?path=index.html`)).text()).toBe('old')
  })

  it('bounds multipart bytes without Content-Length and cancels rejected body streams', async () => {
    const { config, auth, sites, key } = await fixture()
    const handle = createApiHandler({ ...config, limits: { ...config.limits, maxMultipartBodyBytes: 512 } }, auth, sites)
    let cancelled = false
    const request = new Request(`${config.appOrigin}/api/sites/${'a'.repeat(32)}/files`, {
      method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'multipart/form-data; boundary=fixture' },
      body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(513)) }, cancel() { cancelled = true } }), duplex: 'half',
    } as RequestInit)
    expect((await handle(request))!.status).toBe(413)
    expect(cancelled).toBe(true)
  })

  it('rejects cookie authentication, sibling origins and caller-supplied ownership before body parsing', async () => {
    const { config, handle, key, send } = await fixture()
    const attempts: Record<string, string>[] = [{ cookie: '__Host-agp-session=fixture' }, { authorization: `Bearer ${key}`, origin: 'https://attacker.sites.example.com' }]
    for (const headers of attempts) {
      const request = new Request(`${config.appOrigin}/api/sites`, { method: 'POST', headers, body: 'not JSON' })
      expect((await handle(request))!.status).toBe(401)
      expect(request.bodyUsed).toBe(false)
    }
    for (const extra of [{ ownerId: 'other' }, { visibility: 'public' }]) {
      expect((await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Rejected',
        files: [{ path: 'index.html', content: 'private' }], ...extra })).status).toBe(400)
    }
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Scoped', files: [{ path: 'index.html', content: 'private' }] })).json()
    expect((await send(`/api/sites/${created.site.id}?siteId=${'a'.repeat(32)}`)).status).toBe(400)
    expect((await send('/api/sites?limit=1&limit=2')).status).toBe(400)
  })

  it('accepts the exact multipart file limit and rejects excess bytes or incomplete framing atomically', async () => {
    const { send, config, auth, sites, key } = await fixture()
    const handle = createApiHandler({ ...config, limits: { ...config.limits, maxFileBytes: 8 } }, auth, sites)
    const created = await (await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Boundary', files: [{ path: 'index.html', content: 'old' }] })).json()
    const endpoint = `${config.appOrigin}/api/sites/${created.site.id}/files`
    for (const [bytes, expectedVersion, status] of [[8, 1, 200], [9, 2, 413]]) {
      const form = new FormData()
      form.append('manifest', JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion, files: [{ path: 'index.html', partName: 'page' }] }))
      form.append('page', new Blob(['x'.repeat(bytes)]), 'index.html')
      expect((await handle(await multipartRequest(endpoint, key, form)))!.status).toBe(status)
    }
    const form = new FormData()
    form.append('manifest', JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 2, files: [{ path: 'index.html', partName: 'page' }] }))
    form.append('page', new Blob(['bad']), 'index.html')
    const encoded = await multipartRequest(endpoint, key, form)
    const incomplete = (await encoded.arrayBuffer()).slice(0, -5)
    const framingHandler = createApiHandler(config, auth, sites)
    expect((await framingHandler(new Request(endpoint, { method: 'PUT', headers: encoded.headers, body: incomplete })))!.status).toBe(400)
    expect((await (await send(`/api/sites/${created.site.id}`)).json()).version).toBe(2)
    expect(await (await send(`/api/sites/${created.site.id}/file?path=index.html`)).text()).toBe('xxxxxxxx')
  })
})

it('publishes Markdown and PDF through REST JSON and multipart with server-assigned types', async () => {
  const { send, handle, config, key } = await fixture()
  const markdown = '# Site notes\n\nCaffè'
  const response = await send('/api/sites', 'POST', { operationId: crypto.randomUUID(), name: 'Documents', files: [
    { path: 'index.html', content: 'home' }, { path: 'notes.md', content: markdown }, { path: 'guide.pdf', content: '%PDF-1.4\n' },
  ] })
  expect(response.status).toBe(201)
  const { site } = await response.json()
  const notes = await send(`/api/sites/${site.id}/file?path=notes.md`)
  expect(notes.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  expect(await notes.text()).toBe(markdown)
  const initialPdf = await send(`/api/sites/${site.id}/file?path=guide.pdf`)
  expect(initialPdf.headers.get('content-type')).toBe('application/pdf')
  expect(await initialPdf.text()).toBe('%PDF-1.4\n')
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255])
  const form = new FormData()
  form.set('manifest', JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion: 1,
    files: [{ path: 'notes.md', partName: 'notes' }, { path: 'guide.pdf', partName: 'pdf' }] }))
  form.set('notes', new Blob(['# Updated'], { type: 'application/x-ignored' }), 'notes.md')
  form.set('pdf', new Blob([bytes], { type: 'text/html' }), 'misleading.html')
  expect((await handle(await multipartRequest(`${config.appOrigin}/api/sites/${site.id}/files`, key, form)))!.status).toBe(200)
  expect(await (await send(`/api/sites/${site.id}/file?path=notes.md`)).text()).toBe('# Updated')
  const pdf = await send(`/api/sites/${site.id}/file?path=guide.pdf`)
  expect(pdf.headers.get('content-type')).toBe('application/pdf')
  expect(pdf.headers.get('x-content-type-options')).toBe('nosniff')
  expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(bytes)
  expect((await send(`/api/sites/${site.id}/files`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 2,
    files: [{ path: 'video.mp4', content: 'unsupported' }] })).status).toBe(415)
})
