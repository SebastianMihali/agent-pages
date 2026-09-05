import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const passwordHash = 'scrypt$131072$8$1$01010101010101010101010101010101$8e42ace0fdaa6233ab07d1ace292170ded23f47cc4d1034fa021207f1e8467f8'

type RuntimeProcess = {
  child: ChildProcess
  output: () => string
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function cleanEnvironment() {
  const env = { ...process.env }
  for (const name of ['APP_ORIGIN', 'CONTENT_BASE_DOMAIN', 'DATA_DIR', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'PORT']) {
    delete env[name]
  }
  return env
}

function startRuntime(dataDir: string, port: number, extra: NodeJS.ProcessEnv = {}): RuntimeProcess {
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: {
      ...cleanEnvironment(),
      NODE_ENV: 'production',
      APP_ORIGIN: `https://app.agent-pages.localhost:${port}`,
      CONTENT_BASE_DOMAIN: 'sites.agent-pages.localhost',
      DATA_DIR: dataDir,
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: passwordHash,
      PORT: String(port),
      MIN_FREE_DISK_MB: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384) }
  child.stdout!.on('data', capture)
  child.stderr!.on('data', capture)
  return { child, output: () => output }
}

async function waitForLive(runtime: RuntimeProcess, port: number) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) throw new Error(`Runtime exited before listening:\n${runtime.output()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`)
      if (response.ok) return
    } catch {
      // Retry until the process is listening or exits.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Runtime did not listen:\n${runtime.output()}`)
}

async function requestApp(port: number) {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: {
        host: `app.agent-pages.localhost:${port}`,
        'x-forwarded-host': `app.agent-pages.localhost:${port}`,
        'x-forwarded-proto': 'https',
      },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
}

async function waitForExit(runtime: RuntimeProcess, timeout = 8_000) {
  if (runtime.child.exitCode !== null) return { code: runtime.child.exitCode, signal: runtime.child.signalCode }
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime did not exit:\n${runtime.output()}`)), timeout)
    runtime.child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function stop(runtime: RuntimeProcess) {
  if (runtime.child.exitCode !== null) return
  runtime.child.kill('SIGTERM')
  try {
    await waitForExit(runtime, 5_000)
  } catch {
    runtime.child.kill('SIGKILL')
    await waitForExit(runtime)
  }
}

test('production runtime initializes once, owns its data directory, and validates before listen', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'The process boundary is independent of browser engine')
  const root = await mkdtemp(join(tmpdir(), 'agent-pages-production-'))
  const dataDir = join(root, 'data')
  const firstPort = await availablePort()
  const first = startRuntime(dataDir, firstPort)
  try {
    await waitForLive(first, firstPort)
    expect(await requestApp(firstPort)).toBe(200)
    expect(first.child.exitCode).toBeNull()

    const secondPort = await availablePort()
    const second = startRuntime(dataDir, secondPort)
    const secondExit = await waitForExit(second)
    expect(secondExit.code).not.toBe(0)
    await expect(fetch(`http://127.0.0.1:${secondPort}/health/live`)).rejects.toThrow()

    const invalidPort = await availablePort()
    const invalid = startRuntime(join(root, 'invalid'), invalidPort, { APP_ORIGIN: undefined })
    const invalidExit = await waitForExit(invalid)
    expect(invalidExit.code).not.toBe(0)
    expect(invalid.output()).toContain('Invalid configuration fields: APP_ORIGIN')
    await expect(fetch(`http://127.0.0.1:${invalidPort}/health/live`)).rejects.toThrow()
  } finally {
    await stop(first)
    await rm(root, { recursive: true, force: true })
  }
})
