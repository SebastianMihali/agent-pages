import { describe, expect, it } from 'vitest'
import { parseConfig } from './config'
import { createMcpHandler } from './mcp'
import { DomainError } from './errors'

const config = parseConfig({
  NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
  ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
})

describe('MCP HTTP transport', () => {
  it('initializes and executes a tool with stateless JSON responses', async () => {
    const handle = createMcpHandler(config, {
      authenticate: () => ({ ownerId: 'test-owner' }),
      register: (server, owner) => {
        server.registerTool('probe', { description: 'Test fixture only', inputSchema: {} }, () => ({
          content: [{ type: 'text', text: owner.ownerId }],
        }))
      },
    })
    const send = (body: unknown) => handle(new Request('https://app.example.com/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    }))
    const initialized = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } })
    expect(initialized.status).toBe(200)
    expect(initialized.headers.get('content-type')).toContain('application/json')
    const response = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'probe', arguments: {} } })
    expect(await response.json()).toMatchObject({ result: { content: [{ type: 'text', text: 'test-owner' }] } })
  })
  it('rejects unauthenticated discovery before consuming a body', async () => {
    const handle = createMcpHandler(config, {
      authenticate: () => { throw new DomainError('UNAUTHENTICATED', 'A valid API key is required') },
      register: () => { throw new Error('Must not register unauthenticated tools') },
    })
    const request = new Request('https://app.example.com/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'session=not-an-api-key' },
      body: 'not even JSON',
    })
    expect((await handle(request)).status).toBe(401)
    expect(request.bodyUsed).toBe(false)
  })
  it('denies sibling and opaque origins before authenticating', async () => {
    const handle = createMcpHandler(config, {
      authenticate: () => { throw new Error('Origin must be checked first') }, register: () => {},
    })
    for (const origin of ['https://other.sites.example.com', 'null', 'https://app.example.com, https://evil.com']) {
      const response = await handle(new Request('https://app.example.com/mcp', { method: 'GET', headers: { origin } }))
      expect(response.status).toBe(401)
    }
  })
  it('bounds a chunked request without Content-Length', async () => {
    const handle = createMcpHandler({ ...config, limits: { ...config.limits, maxJsonBodyBytes: 8 } }, {
      authenticate: () => ({ ownerId: 'owner' }), register: () => {},
    })
    const response = await handle(new Request('https://app.example.com/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('123456789')); controller.close() } }),
      duplex: 'half',
    } as RequestInit))
    expect(response.status).toBe(413)
  })
})
