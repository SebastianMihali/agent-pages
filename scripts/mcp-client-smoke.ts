import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createAccess } from '../src/server/access.ts'
import { createApiHandler } from '../src/server/api.ts'
import { createAuth } from '../src/server/auth/index.ts'
import { readJson } from '../src/server/body.ts'
import { parseConfig } from '../src/server/config.ts'
import { createContentHandler } from '../src/server/content.ts'
import { openDatabase } from '../src/server/db.ts'
import { errorResponse } from '../src/server/errors.ts'
import { createHostHandler, siteOrigin } from '../src/server/hosts.ts'
import { createMcpHandler } from '../src/server/mcp.ts'
import { registerSiteTools } from '../src/server/mcp-tools.ts'
import { createSiteModule } from '../src/server/sites/index.ts'

const requested = process.argv[2] ?? 'both'
if (!['codex', 'claude', 'both'].includes(requested)) throw new Error('Usage: pnpm exec tsx scripts/mcp-client-smoke.ts [codex|claude|both]')
const root = await mkdtemp(join(tmpdir(), 'agent-pages-live-clients-'))
const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'http://app.localhost', CONTENT_BASE_DOMAIN: 'sites.localhost',
  DATA_DIR: join(root, 'data'), ADMIN_USERNAME: 'fixture-owner', MIN_FREE_DISK_MB: '1',
  ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}` })
const db = openDatabase(config.dataDir)
const auth = createAuth(db, config)
const sites = await createSiteModule(config, db)
const access = createAccess(db, auth, sites)
const owner = { ownerId: auth.ownerId }
const content = createContentHandler(config, sites, access)
const api = createApiHandler(config, auth, sites)
const mcp = createMcpHandler(config, { authenticate: auth.readBearer, register: (server, principal) => registerSiteTools(server, principal, sites, config) })
type Evidence = { method: string; tool?: string; status: number; siteId?: string; version?: number; visibility?: string; anonymousStatus?: number }
let evidence: Evidence[] = []
const route = createHostHandler(config, { ready: () => true, content,
  app: async (request) => {
    if (new URL(request.url).pathname !== '/mcp') return await api(request) ?? new Response('Not found', { status: 404 })
    if (request.method !== 'POST') return mcp(request)
    try {
      auth.readBearer(request)
      const message = await readJson(request, config.limits.maxJsonBodyBytes) as { method?: string; params?: { name?: string } }
      const response = await mcp(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(message) }))
      const entry: Evidence = { method: message.method ?? 'unknown', ...(message.params?.name ? { tool: message.params.name } : {}), status: response.status }
      if (message.method === 'tools/call') {
        const reply = await response.clone().json()
        const structured = reply.result?.structuredContent
        const site = structured?.site ?? (message.params?.name === 'get_site' && typeof structured?.id === 'string' ? structured : undefined)
        if (site) {
          entry.siteId = site.id; entry.version = site.version; entry.visibility = site.visibility
          entry.anonymousStatus = (await content(new Request(`${siteOrigin(config, site.id)}/index.html`), site.id)).status
        }
        if (reply.result?.isError || reply.error) entry.status = 400
        process.stdout.write(`${JSON.stringify({ event: 'live_tool', ...entry })}\n`)
      }
      evidence.push(entry)
      return response
    } catch (error) {
      const response = errorResponse(error)
      evidence.push({ method: 'rejected-before-body', status: response.status })
      return response
    }
  },
})
const server = createServer(async (incoming, outgoing) => {
  try {
    // This loopback-only harness supplies the external application Host, as a proxy would.
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    headers.set('host', config.appAuthority)
    const request = new Request(`${config.appOrigin}${incoming.url}`, { method: incoming.method, headers,
      ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }),
    } as RequestInit)
    const response = await route(request)
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), outgoing)
    else outgoing.end()
  } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end() }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Fixture did not listen on TCP')
const endpoint = `http://127.0.0.1:${address.port}/mcp`

function runClient(command: string, args: string[], cwd: string, key: string | undefined) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const environment = { ...process.env }
    if (key === undefined) delete environment.AGENT_PAGES_API_KEY
    else environment.AGENT_PAGES_API_KEY = key
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-1024 * 1024) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    let forceStop: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      forceStop = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, 180_000)
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(forceStop); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); clearTimeout(forceStop); resolve({ code, output: output.replace(/agp_[A-Za-z0-9_-]{43}/g, '[REDACTED]') }) })
  })
}

function clientMessage(output: string): string {
  let message: string | undefined
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (typeof event.result === 'string') message = event.result
      else if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') message = event.item.text
    } catch { /* Non-JSON startup diagnostics are retained only when no client answer exists. */ }
  }
  return message ?? output.trim().split('\n').slice(-6).join('\n')
}

try {
  for (const client of requested === 'both' ? ['codex', 'claude'] : [requested]) {
    const cwd = join(root, client)
    await mkdir(cwd)
    const credential = auth.createKey(owner, `${client} isolated acceptance`)
    const ids = { create: randomUUID(), write: randomUUID(), public: randomUUID(), private: randomUUID() }
    const name = `live-${client}-${randomUUID()}`
    const prompt = `Run this authorized acceptance workflow using ONLY the agent-pages MCP tools. Do not use shell, file, web, other integrations, or subagents. All data is an isolated throwaway fixture. If the MCP tools are unavailable, report that and stop.
1. create_site with operationId ${ids.create}, name ${name}, files [{"path":"index.html","content":"fixture-v1"},{"path":"about/index.html","content":"about fixture"},{"path":"site.css","content":"body{}"}]. Confirm private version 1 and remember its siteId and URL.
2. read_file index.html; verify fixture-v1. write_files with operationId ${ids.write}, that siteId, expectedVersion 1, files [{"path":"index.html","content":"fixture-v2"}].
3. Repeat EXACTLY the same write_files request with the same operationId and expectedVersion 1. Verify replay returns version 2 at the same URL. Read index.html and verify fixture-v2.
4. set_site_visibility with operationId ${ids.public}, expectedVersion 2, visibility public. This fixture is explicitly authorized to become public. Then set_site_visibility with operationId ${ids.private}, expectedVersion 3, visibility private.
5. get_site and list_files. Confirm version 4, private, same URL and three files. Do not delete it; the harness checks and cleans it.
Return concise JSON containing siteId, url, finalVersion and success, with no credentials or file content.`
    let args: string[]
    if (client === 'codex') {
      args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
        '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
        '-c', 'features.skip_host_skill_discovery=true', '-c', 'web_search="disabled"', '-c', `mcp_servers.agent-pages.url="${endpoint}"`,
        '-c', 'mcp_servers.agent-pages.bearer_token_env_var="AGENT_PAGES_API_KEY"', '-c', 'mcp_servers.agent-pages.default_tools_approval_mode="approve"', prompt]
    } else {
      const filename = join(cwd, 'mcp.json')
      await writeFile(filename, JSON.stringify({ mcpServers: { 'agent-pages': { type: 'http', url: endpoint, headers: { Authorization: 'Bearer ${AGENT_PAGES_API_KEY}' } } } }), { mode: 0o600 })
      args = ['--print', '--strict-mcp-config', '--mcp-config', filename, '--setting-sources', '', '--no-session-persistence', '--tools', '',
        '--allowedTools', 'mcp__agent-pages__*', '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk', '--output-format', 'json', prompt]
    }
    evidence = []
    const version = execFileSync(client, ['--version'], { encoding: 'utf8' }).trim()
    console.log(JSON.stringify({ event: 'client_start', client, version }))
    const completed = await runClient(client, args, cwd, credential.key)
    const found = (await sites.listSites(owner)).sites.find((site) => site.name === name)
    const calls = evidence.filter((entry) => entry.tool)
    let passed = false
    if (found) {
      const bytes = await new Response((await sites.openOwnedFile(owner, { siteId: found.id, path: 'index.html' })).body).text()
      passed = completed.code === 0 && found.version === 4 && found.visibility === 'private' && found.fileCount === 3 && bytes === 'fixture-v2' &&
        calls.filter((entry) => entry.tool === 'write_files' && entry.version === 2).length === 2 &&
        calls.some((entry) => entry.visibility === 'public' && entry.anonymousStatus === 200) &&
        calls.some((entry) => entry.version === 4 && entry.anonymousStatus === 404)
    }
    let reconnected = false
    if (found && passed) {
      const reconnectPrompt = `Use ONLY agent-pages MCP tools. This is a second isolated client invocation. Do not use shell, file, web, other integrations or subagents. Use get_site for existing site ${found.id}, then read_file for its index.html. Confirm private version 4 and content fixture-v2. Do not create or mutate anything. Return concise JSON with siteId, version and success; if unavailable report the failure and stop.`
      evidence = []
      console.log(JSON.stringify({ event: 'client_reconnect_start', client }))
      const reopened = await runClient(client, [...args.slice(0, -1), reconnectPrompt], cwd, credential.key)
      reconnected = reopened.code === 0 && evidence.some((entry) => entry.method === 'initialize') &&
        evidence.some((entry) => entry.tool === 'get_site' && entry.status === 200 && entry.siteId === found.id && entry.version === 4) &&
        evidence.some((entry) => entry.tool === 'read_file' && entry.status === 200) &&
        evidence.every((entry) => !entry.tool || ['get_site', 'read_file'].includes(entry.tool))
      console.log(JSON.stringify({ event: 'client_reconnect_result', client, passed: reconnected, exitCode: reopened.code,
        toolCalls: evidence.filter((entry) => entry.tool).map((entry) => entry.tool), ...(!reconnected ? { diagnostics: reopened.output.slice(-4000) } : {}) }))
    }
    const credentialCases: Array<{ kind: string; passed: boolean }> = []
    for (const kind of ['missing', 'invalid']) {
      const before = JSON.stringify(await sites.listSites(owner))
      evidence = []
      const failurePrompt = `Use ONLY the agent-pages MCP get_site tool to read site ${found?.id ?? 'a'.repeat(32)}. This invocation deliberately tests unavailable credentials. If the configured MCP server or credentials are unavailable, report that explicitly and stop without claiming success. Do not create or mutate anything, read environment variables, use shell/file/web tools, other integrations or subagents.`
      console.log(JSON.stringify({ event: 'client_credential_case_start', client, kind }))
      const rejected = await runClient(client, [...args.slice(0, -1), failurePrompt], cwd, kind === 'missing' ? undefined : `agp_${'x'.repeat(43)}`)
      const unchanged = JSON.stringify(await sites.listSites(owner)) === before
      const denial = evidence.some((entry) => entry.status === 401)
      const explicitFailure = /AGENT_PAGES_API_KEY|unauthorized|unauthenticated|401|missing environment|MCP.*(?:failed|unavailable)|(?:failed|unavailable).*MCP/i.test(rejected.output)
      const casePassed = rejected.code !== null && unchanged && !evidence.some((entry) => entry.tool) &&
        (kind === 'invalid' ? denial : explicitFailure)
      credentialCases.push({ kind, passed: casePassed })
      console.log(JSON.stringify({ event: 'client_credential_case_result', client, kind, passed: casePassed, exitCode: rejected.code,
        authenticatedToolCalls: evidence.filter((entry) => entry.tool).length, unauthorizedHttpRequests: evidence.filter((entry) => entry.status === 401).length,
        stateUnchanged: unchanged, diagnosticExcerpt: clientMessage(rejected.output).slice(-2200) }))
    }
    auth.revokeKey(owner, credential.id)
    const revoked = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const report = { event: 'client_result', client, version, exitCode: completed.code, passed, reconnected, credentialCases, keyRevocationStatus: revoked.status,
      site: found ? { id: found.id, version: found.version, visibility: found.visibility, fileCount: found.fileCount } : null,
      toolCalls: calls.map((entry) => entry.tool), ...(!passed ? { diagnostics: completed.output.slice(-8000) } : {}) }
    console.log(JSON.stringify(report))
    if (!passed || !reconnected || credentialCases.some((entry) => !entry.passed) || revoked.status !== 401) process.exitCode = 1
    if (found) await sites.deleteSite(owner, { operationId: randomUUID(), siteId: found.id, expectedVersion: found.version })
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sites.close()
  db.close()
  await rm(root, { recursive: true, force: true })
}
