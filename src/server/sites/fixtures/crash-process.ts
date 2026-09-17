import { parseConfig } from '../../config'
import { openDatabase } from '../../db'
import { createSiteModule } from '..'

type CrashCommand = Readonly<{
  dataDir: string
  ownerId: string
  siteId: string
  operationId: string
}>

async function main() {
  const input = process.env.AGENT_PAGES_CRASH_FIXTURE
  if (!input) throw new Error('AGENT_PAGES_CRASH_FIXTURE is required')
  const command = JSON.parse(input) as CrashCommand
  const config = parseConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com',
    DATA_DIR: command.dataDir,
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
    MIN_FREE_DISK_MB: '1',
  })
  const database = openDatabase(command.dataDir)
  const sites = await createSiteModule(config, database, {
    fault(point) {
      if (point === 'after-finalize') process.exit(91)
    },
  })
  await sites.recover()
  await sites.writeFiles({ ownerId: command.ownerId }, {
    operationId: command.operationId,
    siteId: command.siteId,
    expectedVersion: 1,
    files: [{ path: 'index.html', content: 'never active' }],
  })
  throw new Error('Crash fixture completed without reaching its crash point')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
