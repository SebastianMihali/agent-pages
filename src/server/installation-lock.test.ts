import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireInstallationLock } from './installation-lock'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('installation lock', () => {
  it('rejects a second live holder and can be acquired after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-pages-lock-')); roots.push(root)
    const first = await acquireInstallationLock(root)
    await expect(acquireInstallationLock(root)).rejects.toThrow('already in use')
    await first.release()
    const next = await acquireInstallationLock(root)
    await next.release()
  })

  it('excludes another process and recovers after an abrupt process exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-pages-lock-')); roots.push(root)
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/server/installation-lock.ts')).href
    const script = `import { acquireInstallationLock } from ${JSON.stringify(moduleUrl)}; await acquireInstallationLock(process.argv[1]); process.stdout.write('locked\\n'); setInterval(() => {}, 1000)`
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const [chunk] = await once(child.stdout!, 'data')
      expect(String(chunk)).toContain('locked')
      await expect(acquireInstallationLock(root)).rejects.toThrow('already in use')
    } finally {
      child.kill('SIGKILL'); await once(child, 'exit')
    }
    const recovered = await acquireInstallationLock(root)
    await recovered.release()
  })
})
