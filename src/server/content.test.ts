import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAuth } from './auth'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule } from './sites'
import { createAccess } from './access'
import { createContentHandler } from './content'
import { createHostHandler } from './hosts'
import { createApiHandler } from './api'

it('serves only the active public revision and keeps management routes on the application host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-content-history-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` })
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  try {
    const principal = { ownerId: auth.ownerId }
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Public history',
      files: [{ path: 'index.html', content: 'old public bytes' }] })
    await sites.setVisibility(principal, { siteId: site.id, operationId: randomUUID(), expectedVersion: 1, visibility: 'public' })
    await sites.writeFiles(principal, { siteId: site.id, operationId: randomUUID(), expectedVersion: 2,
      files: [{ path: 'index.html', content: 'current public bytes' }] })
    const api = createApiHandler(config, auth, sites)
    const content = createContentHandler(config, sites, createAccess(db, auth, sites))
    const handle = createHostHandler(config, { app: async (request) => await api(request) ?? new Response('Not found', { status: 404 }),
      content, ready: () => true })
    const key = auth.createKey(principal, 'History test').key
    const query = `?revisionId=${site.revisionId}`
    for (const suffix of ['', query]) {
      const response = await handle(new Request(`${site.url}/index.html${suffix}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('current public bytes')
    }
    const managementPath = `/api/sites/${site.id}/revisions`
    const appResponse = await handle(new Request(`${config.appOrigin}${managementPath}`, { headers: { authorization: `Bearer ${key}` } }))
    expect(appResponse.status).toBe(200)
    expect((await appResponse.json()).revisions).toHaveLength(2)
    const contentResponse = await handle(new Request(`${site.url}${managementPath}`, { headers: { authorization: `Bearer ${key}` } }))
    expect(contentResponse.status).toBe(404)
    expect(contentResponse.headers.get('content-type')).not.toBe('application/json')
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})

it('authorizes before file routing and serves public nested routes, MIME and HEAD consistently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-content-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` })
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  try {
    const principal = { ownerId: auth.ownerId }
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Private', files: [
      { path: 'index.html', content: 'secret' }, { path: 'about/index.html', content: 'nested' },
      { path: '404.html', content: 'custom missing' }, { path: 'style.css', content: 'body{}' },
    ] })
    const handle = createContentHandler(config, sites, createAccess(db, auth, sites))
    const get = (path: string, init?: RequestInit) => handle(new Request(site.url + '/' + path, init), site.id)
    for (const path of ['', 'about', 'missing', 'style.css']) {
      expect((await get(path)).status).toBe(404)
      expect((await get(path, { method: 'HEAD' })).status).toBe(404)
    }
    const navigation = await get('about', { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
    expect(navigation.status).toBe(303)
    expect(navigation.headers.get('location')).toContain(config.appOrigin)
    await sites.setVisibility(principal, { siteId: site.id, operationId: randomUUID(), expectedVersion: 1, visibility: 'public' })
    const redirect = await get('about?x=1')
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/about/?x=1')
    const css = await get('style.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(css.headers.get('cache-control')).toBe('no-store')
    expect(await css.text()).toBe('body{}')
    const missing = await get('missing')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe('custom missing')
    const head = await get('about/', { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('6')
    expect(await head.text()).toBe('')
    expect((await get('index.html', { headers: { 'service-worker': 'script' } })).status).toBe(404)
    // Malformed visitor requests are expected outcomes: 404 without an operator log entry.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await get('%2findex.html')).status).toBe(404)
      expect((await get('%zz')).status).toBe(404)
      expect((await get('_agent/session')).status).toBe(404)
      expect((await get('_agent/session', { method: 'POST', headers: { origin: config.appOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new Uint8Array([0xff]) })).status).toBe(404)
      expect(logged).not.toHaveBeenCalled()
    } finally { logged.mockRestore() }
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})

it('marks every site response as not indexable, including denials, redirects and HEAD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-content-robots-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` })
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  try {
    const principal = { ownerId: auth.ownerId }
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Robots', files: [
      { path: 'index.html', content: 'home' }, { path: 'about/index.html', content: 'nested' },
      { path: '404.html', content: 'custom missing' }, { path: 'style.css', content: 'body{}' },
    ] })
    const handle = createContentHandler(config, sites, createAccess(db, auth, sites))
    const get = (path: string, init?: RequestInit) => handle(new Request(site.url + '/' + path, init), site.id)
    const robots = async (path: string, init?: RequestInit) => (await get(path, init)).headers.get('x-robots-tag')
    // Private: denied asset, denied HEAD and the owner-handoff redirect.
    expect(await robots('style.css')).toBe('noindex, nofollow')
    expect(await robots('', { method: 'HEAD' })).toBe('noindex, nofollow')
    expect(await robots('about', { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).toBe('noindex, nofollow')
    await sites.setVisibility(principal, { siteId: site.id, operationId: randomUUID(), expectedVersion: 1, visibility: 'public' })
    // Public: page, asset, HEAD, canonical redirect, custom 404 and invalid path.
    expect(await robots('')).toBe('noindex, nofollow')
    expect(await robots('style.css')).toBe('noindex, nofollow')
    expect(await robots('about/', { method: 'HEAD' })).toBe('noindex, nofollow')
    expect(await robots('about')).toBe('noindex, nofollow')
    expect(await robots('missing')).toBe('noindex, nofollow')
    expect(await robots('%2findex.html')).toBe('noindex, nofollow')
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})

it('serves Markdown and PDF with exact bytes and content-host security headers without forcing downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-content-documents-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` })
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  try {
    const principal = { ownerId: auth.ownerId }
    const markdown = new TextEncoder().encode('# Read me\n\n<script>untrusted()</script>')
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255])
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Documents', files: [
      { path: 'index.html', content: 'home' }, { path: 'notes.md', body: markdown, maximumBytes: markdown.length },
      { path: 'guide.pdf', body: pdf, maximumBytes: pdf.length },
    ] })
    const handle = createContentHandler(config, sites, createAccess(db, auth, sites))
    for (const path of ['notes.md', 'guide.pdf']) expect((await handle(new Request(`${site.url}/${path}`), site.id)).status).toBe(404)
    await sites.setVisibility(principal, { siteId: site.id, operationId: randomUUID(), expectedVersion: 1, visibility: 'public' })
    for (const [path, mime, bytes] of [['notes.md', 'text/markdown; charset=utf-8', markdown], ['guide.pdf', 'application/pdf', pdf]] as const) {
      for (const method of ['GET', 'HEAD']) {
        const response = await handle(new Request(`${site.url}/${path}`, { method }), site.id)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(mime)
        expect(response.headers.get('content-length')).toBe(String(bytes.length))
        expect(response.headers.get('content-disposition')).toBeNull()
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
        expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(method === 'GET' ? bytes : new Uint8Array())
      }
    }
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})
