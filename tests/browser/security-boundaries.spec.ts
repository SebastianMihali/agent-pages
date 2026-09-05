import { expect, test } from '@playwright/test'
import { appOrigin, bearer, createSite, issueKey, setVisibility, signIn } from './support'

test('a public sibling cannot read the application or another private site', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  await signIn(page)
  const key = await issueKey(page, `Isolation ${browser.browserType().name()} ${Date.now()}`)
  const target = (await createSite(page.request, key, `Private target ${Date.now()}`, [
    { path: 'index.html', content: '<!doctype html><h1>Private target secret</h1>' },
    { path: 'private.js', content: 'self.postMessage("private worker executed")' },
  ])).site
  const attacker = (await createSite(page.request, key, `Public attacker ${Date.now()}`, [
    { path: 'index.html', content: `<!doctype html><h1>Attacker fixture</h1><script>
      const results = document.documentElement.dataset
      Promise.all([
        fetch(${JSON.stringify(`${appOrigin}/web/session`)}, { credentials: 'include' }).then(() => 'read').catch(() => 'blocked'),
        fetch(${JSON.stringify(`${target.url}/private.js`)}, { credentials: 'include' }).then(() => 'read').catch(() => 'blocked'),
      ]).then(([app, site]) => { results.appFetch = app; results.siteFetch = site })
      const before = location.hostname
      try { document.domain = 'sites.agent-pages.localhost' } catch {}
      results.domain = document.domain === before ? 'blocked' : 'relaxed'
      let workerExecuted = false
      try {
        const worker = new Worker(${JSON.stringify(`${target.url}/private.js`)})
        worker.onmessage = () => { workerExecuted = true }
      } catch {}
      const frame = document.createElement('iframe')
      frame.src = ${JSON.stringify(target.url)}
      document.body.append(frame)
      setTimeout(() => {
        try { results.frame = frame.contentDocument?.body?.innerText ? 'read' : 'blocked' } catch { results.frame = 'blocked' }
        results.worker = workerExecuted ? 'executed' : 'blocked'
        results.cookie = document.cookie || 'empty'
        results.ready = 'yes'
      }, 800)
    </script>` },
  ])).site
  const publicAttacker = (await setVisibility(page.request, key, attacker, 'public')).site

  const response = await page.goto(publicAttacker.url)
  expect(response?.status()).toBe(200)
  expect(response?.headers()['cross-origin-resource-policy']).toBe('same-origin')
  expect(response?.headers()['origin-agent-cluster']).toBe('?1')
  expect(response?.headers()['content-security-policy']).toContain("worker-src 'none'")
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.ready)).toBe('yes')
  const results = await page.evaluate(() => ({ ...document.documentElement.dataset }))
  expect(results).toMatchObject({
    appFetch: 'blocked',
    siteFetch: 'blocked',
    frame: 'blocked',
    worker: 'blocked',
    domain: 'blocked',
    cookie: 'empty',
  })
  expect(await page.getByText('Private target secret').count()).toBe(0)
})

type McpResponse = {
  result?: {
    tools?: Array<{ name: string }>
    isError?: boolean
    structuredContent?: Record<string, unknown>
  }
}

test('the production MCP transport authenticates discovery and preserves structured conflicts', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  await signIn(page)
  const key = await issueKey(page, `MCP ${browser.browserType().name()} ${Date.now()}`)
  const send = async (id: number, method: string, params: Record<string, unknown>, token?: string) => {
    const response = await page.request.post('/mcp', {
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(token ? bearer(token) : {}),
      },
      data: { jsonrpc: '2.0', id, method, params },
    })
    return { response, body: await response.json() as McpResponse }
  }

  const cookieOnly = await send(1, 'tools/list', {})
  expect(cookieOnly.response.status()).toBe(401)
  const initialized = await send(2, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'playwright', version: '1' },
  }, key)
  expect(initialized.response.status()).toBe(200)
  const listed = await send(3, 'tools/list', {}, key)
  expect(listed.body.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
    'create_site', 'list_sites', 'read_file', 'write_files', 'set_site_visibility',
  ]))

  const created = await send(4, 'tools/call', { name: 'create_site', arguments: {
    operationId: crypto.randomUUID(), name: `MCP transport ${Date.now()}`,
    files: [{ path: 'index.html', content: '<!doctype html><h1>MCP production transport</h1>' }],
  } }, key)
  const site = (created.body.result?.structuredContent as { site?: { id: string; version: number } } | undefined)?.site
  expect(site).toMatchObject({ version: 1 })

  const changed = await send(5, 'tools/call', { name: 'set_site_visibility', arguments: {
    siteId: site!.id, operationId: crypto.randomUUID(), expectedVersion: site!.version, visibility: 'public',
  } }, key)
  expect(changed.body.result?.isError).not.toBe(true)
  const stale = await send(6, 'tools/call', { name: 'set_site_visibility', arguments: {
    siteId: site!.id, operationId: crypto.randomUUID(), expectedVersion: site!.version, visibility: 'private',
  } }, key)
  expect(stale.body.result).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'VERSION_CONFLICT', retryable: false } },
  })
})
