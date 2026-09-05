import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { flock } from 'fs-ext'

export interface InstallationLock { release(): Promise<void> }

const lock = (descriptor: number, operation: 'exnb' | 'un') => new Promise<void>((resolve, reject) => {
  flock(descriptor, operation, (error) => { if (error) reject(error); else resolve() })
})

export async function acquireInstallationLock(dataDir: string): Promise<InstallationLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const handle = await open(join(dataDir, '.agent-pages.lock'), 'a+', 0o600)
  try {
    await handle.chmod(0o600)
    await lock(handle.fd, 'exnb')
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
    try { await lock(handle.fd, 'un') }
    finally { await handle.close() }
  } }
}
