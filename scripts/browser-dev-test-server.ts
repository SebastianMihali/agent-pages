import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = 3553
const testRoot = await mkdtemp(join(tmpdir(), 'agent-pages-browser-dev-'))
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  APP_ORIGIN: `http://app.agent-pages.localhost:${port}`,
  CONTENT_BASE_DOMAIN: 'sites.agent-pages.localhost',
  DATA_DIR: join(testRoot, 'data'),
  ADMIN_USERNAME: 'owner',
  ADMIN_PASSWORD_HASH: 'scrypt$131072$8$1$01010101010101010101010101010101$8e42ace0fdaa6233ab07d1ace292170ded23f47cc4d1034fa021207f1e8467f8',
  PORT: String(port),
  MIN_FREE_DISK_MB: '1',
  MAX_MUTATIONS_PER_MINUTE: '1000',
}

// Keep only process settings needed to launch Node; do not inherit repository
// credentials or application configuration from the developer's environment.
for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'] as const) {
  if (process.env[name]) environment[name] = process.env[name]
}

const development = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js',
  'dev',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort',
], { cwd: process.cwd(), env: environment, stdio: 'inherit' })

let stopping = false
let cleaned = false

async function clean() {
  if (cleaned) return
  cleaned = true
  await rm(testRoot, { recursive: true, force: true })
}

function stop(signal: NodeJS.Signals) {
  if (stopping) return
  stopping = true
  development.kill(signal)
  setTimeout(() => development.kill('SIGKILL'), 5_000).unref()
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
development.once('error', (error) => {
  console.error('Development browser test server failed to start', error)
  void clean().finally(() => process.exit(1))
})
development.once('exit', (code) => {
  void clean().finally(() => process.exit(stopping ? 0 : code ?? 1))
})
