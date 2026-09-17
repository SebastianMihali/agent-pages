import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const publicPort = 3443
const runtimePort = 3444
const testRoot = await mkdtemp(join(tmpdir(), 'agent-pages-browser-'))
const keyPath = join(testRoot, 'localhost-key.pem')
const certPath = join(testRoot, 'localhost-cert.pem')

await run('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=app.agent-pages.localhost',
  '-addext', 'subjectAltName=DNS:app.agent-pages.localhost,DNS:sites.agent-pages.localhost,DNS:*.sites.agent-pages.localhost',
  '-keyout', keyPath,
  '-out', certPath,
])

const runtime = spawn(process.execPath, ['.output/server/index.mjs'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    APP_ORIGIN: `https://app.agent-pages.localhost:${publicPort}`,
    CONTENT_BASE_DOMAIN: 'sites.agent-pages.localhost',
    DATA_DIR: join(testRoot, 'data'),
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: 'scrypt$131072$8$1$01010101010101010101010101010101$8e42ace0fdaa6233ab07d1ace292170ded23f47cc4d1034fa021207f1e8467f8',
    PORT: String(runtimePort),
    MIN_FREE_DISK_MB: '1',
    // Both engine projects exercise many mutations in one isolated installation.
    MAX_MUTATIONS_PER_MINUTE: '1000',
  },
  stdio: 'inherit',
})

// One bounded, fixture-only gate lets both engines cancel a real TLS transfer.
const pausedUploads = new Map<string, {
  state: { forwardedBytes: number; aborted: boolean; upstreamClosed: boolean }
  close: () => void
  resume: () => void
}>()

const proxy = createServer({
  key: await readFile(keyPath),
  cert: await readFile(certPath),
}, (incoming, outgoing) => {
  const inspection = /^\/__test\/upload-state\/([a-f0-9-]{36})$/.exec(incoming.url ?? '')
  if (inspection) {
    const upload = pausedUploads.get(inspection[1])
    if (!upload) { outgoing.writeHead(404).end(); return }
    if (incoming.method === 'DELETE') {
      upload.close(); pausedUploads.delete(inspection[1]); outgoing.writeHead(204).end()
    } else if (incoming.method === 'POST') {
      upload.resume(); outgoing.writeHead(204).end()
    } else if (incoming.method === 'GET') {
      outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(upload.state))
    } else outgoing.writeHead(405).end()
    return
  }
  const pauseId = incoming.headers['x-agent-pages-test-paused-upload']
  delete incoming.headers['x-agent-pages-test-paused-upload']
  if (pauseId && (typeof pauseId !== 'string' || !/^[a-f0-9-]{36}$/.test(pauseId) || pausedUploads.size >= 1)) {
    outgoing.writeHead(400).end(); return
  }
  const state = { forwardedBytes: 0, aborted: false, upstreamClosed: false }
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: runtimePort,
    method: incoming.method,
    path: incoming.url,
    headers: {
      ...incoming.headers,
      'x-forwarded-host': incoming.headers.host ?? '',
      'x-forwarded-proto': 'https',
    },
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.rawHeaders)
    response.pipe(outgoing)
  })
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502)
    outgoing.end('Upstream unavailable')
  })
  incoming.once('aborted', () => { state.aborted = true; upstream.destroy() })
  outgoing.once('close', () => { if (!outgoing.writableFinished) upstream.destroy() })
  upstream.once('close', () => { state.upstreamClosed = true })
  if (typeof pauseId === 'string') {
    let resumed = false
    pausedUploads.set(pauseId, {
      state,
      close: () => { incoming.destroy(); upstream.destroy() },
      resume: () => {
        if (resumed) return
        resumed = true
        incoming.on('data', (chunk: Buffer) => { state.forwardedBytes += chunk.length })
        incoming.pipe(upstream)
      },
    })
    incoming.once('data', (chunk: Buffer) => {
      incoming.pause()
      upstream.write(chunk, () => { state.forwardedBytes = chunk.length })
    })
  } else incoming.pipe(upstream)
})

async function waitForRuntime() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/health/live`, {
        headers: { host: `127.0.0.1:${runtimePort}` },
      })
      if (response.ok) return
    } catch {
      // The child has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Production runtime did not become live')
}

let stopping = false
async function stop(signal: NodeJS.Signals) {
  if (stopping) return
  stopping = true
  proxy.close()
  runtime.kill(signal)
  await Promise.race([
    new Promise<void>((resolve) => runtime.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
  await rm(testRoot, { recursive: true, force: true })
  process.exit(0)
}

process.once('SIGINT', () => void stop('SIGINT'))
process.once('SIGTERM', () => void stop('SIGTERM'))
runtime.once('exit', (code) => {
  if (!stopping) {
    console.error(`Production runtime exited unexpectedly with code ${code ?? 'unknown'}`)
    void rm(testRoot, { recursive: true, force: true }).finally(() => process.exit(1))
  }
})

await waitForRuntime()
await new Promise<void>((resolve) => proxy.listen(publicPort, '127.0.0.1', resolve))
console.log(`Browser test proxy listening on https://app.agent-pages.localhost:${publicPort}`)
