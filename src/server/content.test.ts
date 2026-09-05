import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAuth } from './auth'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createSiteModule } from './sites'
import { createAccess } from './access'
import { createContentHandler } from './content'

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
    expect((await get('%2findex.html')).status).toBe(404)
    expect((await get('_agent/session')).status).toBe(404)
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
})
