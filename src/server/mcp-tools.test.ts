import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth } from './auth'
import { createApiHandler } from './api'
import { parseConfig } from './config'
import { openDatabase } from './db'
import { createMcpHandler } from './mcp'
import { registerSiteTools } from './mcp-tools'
import { createSiteModule } from './sites'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0)) await close() })

async function fixture(overrides: Record<string, string> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-pages-tools-'))
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com', DATA_DIR: dataDir,
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`, MIN_FREE_DISK_MB: '1', ...overrides })
  const db = openDatabase(dataDir)
  const auth = createAuth(db, config)
  const sites = await createSiteModule(config, db)
  dispose.push(async () => { await sites.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
  const key = auth.createKey({ ownerId: auth.ownerId }, 'Fixture').key
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const handle = createMcpHandler(config, { authenticate: auth.readBearer, register: (server, principal) => registerSiteTools(server, principal, sites, config) })
  const rpc = async (method: string, params?: unknown) => (await handle(new Request(`${config.appOrigin}/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))).json()
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result
  return { config, auth, sites, headers, api: createApiHandler(config, auth, sites), rpc, call }
}

describe('site tools through the official MCP HTTP transport', () => {
  it('discovers exactly the site tools and replays a REST creation through MCP without a second site', async () => {
    const { config, headers, api, rpc, call } = await fixture()
    const discovery = await rpc('tools/list')
    expect(discovery.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'create_site', 'delete_files', 'delete_site', 'get_site', 'list_files', 'list_sites', 'read_file', 'set_site_visibility', 'write_files',
    ])
    const command = { operationId: crypto.randomUUID(), name: 'Cross transport', files: [{ path: 'index.html', content: 'private text' }] }
    const rest = await api(new Request(`${config.appOrigin}/api/sites`, { method: 'POST', headers, body: JSON.stringify(command) }))
    const created = await rest!.json()
    const result = await call('create_site', command)
    expect(result.structuredContent).toEqual(created)
    expect(result.isError).not.toBe(true)
    expect((await call('list_sites', {})).structuredContent.sites).toHaveLength(1)
    expect((await call('read_file', { siteId: created.site.id, path: 'index.html' })).structuredContent)
      .toMatchObject({ path: 'index.html', content: 'private text', sizeBytes: 12 })
  })

  it('returns authenticated download metadata for large text and binary and structured owner-scoped errors', async () => {
    const { call, sites, auth } = await fixture({ MAX_MCP_TEXT_BYTES: '8' })
    const created = (await call('create_site', { operationId: crypto.randomUUID(), name: 'Bounded',
      files: [{ path: 'index.html', content: 'too large for tool text' }] })).structuredContent
    await sites.writeFiles({ ownerId: auth.ownerId }, { operationId: crypto.randomUUID(), siteId: created.site.id, expectedVersion: 1,
      files: [{ path: 'image.png', body: new Uint8Array([137, 80, 78, 71]), maximumBytes: 4 }] })
    for (const path of ['index.html', 'image.png']) {
      const read = await call('read_file', { siteId: created.site.id, path })
      expect(read.structuredContent).not.toHaveProperty('content')
      expect(read.structuredContent.downloadPath).toMatch(new RegExp(`^/api/sites/${created.site.id}/file\\?`))
      expect(read.structuredContent.downloadPath).toContain('revisionId=')
    }
    const denied = await call('get_site', { siteId: 'a'.repeat(32) })
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_FOUND', retryable: false } } })
    const invalid = await call('create_site', { operationId: crypto.randomUUID(), name: 'Exposed', visibility: 'public', files: [{ path: 'index.html', content: 'no' }] })
    expect(invalid.isError).toBe(true)
  })
})
