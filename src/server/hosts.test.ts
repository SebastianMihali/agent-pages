import { describe, expect, it } from 'vitest'
import { parseConfig } from './config'
import { createHostHandler } from './hosts'

const config = parseConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'https://app.example.com',
  CONTENT_BASE_DOMAIN: 'sites.example.com',
  ADMIN_USERNAME: 'owner',
  ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
})
const siteId = 'a'.repeat(32)
const handle = createHostHandler(config, {
  app: () => new Response('application'),
  content: (_request, id) => new Response(`site:${id}`),
  ready: () => true,
})

describe('HTTP host isolation', () => {
  it('dispatches the application and one exact content host separately', async () => {
    expect(await (await handle(new Request('https://app.example.com/'))).text()).toBe('application')
    expect(await (await handle(new Request(`https://${siteId}.sites.example.com/`))).text()).toBe(`site:${siteId}`)
    expect((await handle(new Request('https://evil.example.com/'))).status).toBe(404)
  })
  it('rejects conflicting Host authority even when a fetch adapter used forwarded headers', async () => {
    const response = await handle(new Request('https://app.example.com/api/sites', {
      headers: { host: 'evil.example.com', 'x-forwarded-host': 'app.example.com' },
    }))
    expect(response.status).toBe(404)
  })
  it.each([
    `https://${siteId}.sites.example.com.evil.com/`,
    `https://nested.${siteId}.sites.example.com/`,
    'https://app.example.com:8443/',
    'https://app.example.com./',
    'https://sites.example.com/',
  ])('does not dispatch a lookalike authority: %s', async (url) => {
    expect((await handle(new Request(url))).status).toBe(404)
  })
  it('ignores spoofed forwarded values on an unknown host', async () => {
    const response = await handle(new Request('http://evil.example.com/', {
      headers: { 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' },
    }))
    expect(response.status).toBe(404)
  })
  it('exposes only minimal health checks on the internal probe host', async () => {
    const live = await handle(new Request('http://127.0.0.1:3000/health/live'))
    expect(await live.json()).toEqual({ status: 'ok' })
    expect((await handle(new Request('http://127.0.0.1:3000/api/sites'))).status).toBe(404)
  })
})
