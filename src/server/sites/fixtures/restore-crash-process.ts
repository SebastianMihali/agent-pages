import { parseConfig } from '../../config'
import { openDatabase } from '../../db'
import { createSiteModule } from '..'

type CrashCommand = Readonly<{
  dataDir: string
  ownerId: string
  siteId: string
  revisionId: string
  expectedVersion: number
  operationId: string
  point: 'before-restore-commit' | 'after-commit'
}>

async function main() {
  const input = process.env.AGENT_PAGES_RESTORE_CRASH_FIXTURE
  if (!input) throw new Error('AGENT_PAGES_RESTORE_CRASH_FIXTURE is required')
  const command = JSON.parse(input) as CrashCommand
  const config = parseConfig({
    NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: command.dataDir, ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
    MIN_FREE_DISK_MB: '1',
  })
  const database = openDatabase(command.dataDir)
  const sites = await createSiteModule(config, database, {
    fault(point) { if (point === command.point) process.exit(92) },
  })
  await sites.recover()
  await sites.restoreRevision({ ownerId: command.ownerId }, command)
  throw new Error('Restore completed without reaching the crash point')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
