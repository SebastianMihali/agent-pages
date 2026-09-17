import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { flockSync } from 'fs-ext'

export interface InstallationLock { release(): Promise<void> }

// Non-blocking flock returns immediately, so the synchronous call costs nothing.
// The asynchronous variant completes on the libuv threadpool through a Nan
// callback that crashes the process under Vite's development server.
const lock = (descriptor: number, operation: 'exnb' | 'un') => { flockSync(descriptor, operation) }

export async function acquireInstallationLock(dataDir: string): Promise<InstallationLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const handle = await open(join(dataDir, '.agent-pages.lock'), 'a+', 0o600)
  try {
    await handle.chmod(0o600)
    lock(handle.fd, 'exnb')
  } catch (error) {
    await handle.close()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
      throw new Error('The data directory is already in use by another Agent Pages process', { cause: error })
    }
    throw new Error('Could not acquire the installation data-directory lock', { cause: error })
  }
  let released = false
  return { async release() {
    if (released) return
    released = true
    try { lock(handle.fd, 'un') }
    finally { await handle.close() }
  } }
}
