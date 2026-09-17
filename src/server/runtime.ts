import { parseConfig } from './config'
import { acquireInstallationLock } from './installation-lock'
import { openDatabase } from './db'
import { createAuth } from './auth'
import { createSiteModule } from './sites'
import { createAccess } from './access'
import { createAdmission } from './admission'
import { logFailure } from './errors'

// Nitro bootstrap and TanStack SSR are separate bundles in the same process.
// They must share the single volume lock, database and shutdown lifecycle.
const processRuntime = globalThis as typeof globalThis & { __agentPagesRuntime?: ReturnType<typeof initialize> }

async function initialize() {
  const config = parseConfig(process.env)
  // Lock before opening SQLite: authentication startup deliberately revokes sessions.
  const lock = await acquireInstallationLock(config.dataDir)
  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(config.dataDir)
    const auth = createAuth(db, config, config.authLimits)
    const sites = await createSiteModule(config, db)
    const access = createAccess(db, auth, sites)
    const admit = createAdmission(config.limits.maxConcurrentMutations + config.limits.maxQueuedMutations)
    await sites.recover()
    let closing = false
    let cleanup: Promise<void> | undefined
    const timer = setInterval(() => {
      if (closing || cleanup) return
      cleanup = (async () => {
        auth.sweepExpired()
        access.sweepExpired()
        await sites.runCleanup()
      })().catch((error: unknown) => { logFailure('cleanup_failed', error) })
        .finally(() => { cleanup = undefined })
    }, 60_000)
    timer.unref()
    return { config, auth, sites, access, admit, ready: () => !closing,
      async close() {
        if (closing) return
        closing = true
        clearInterval(timer)
        await cleanup
        await sites.close()
        db!.close()
        await lock.release()
      },
    }
  } catch (error) { db?.close(); await lock.release(); throw error }
}

export function getRuntime() {
  processRuntime.__agentPagesRuntime ??= initialize()
  return processRuntime.__agentPagesRuntime
}
