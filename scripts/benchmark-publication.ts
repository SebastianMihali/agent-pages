import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createAuth } from '../src/server/auth/index'
import { parseConfig } from '../src/server/config'
import { openDatabase } from '../src/server/db'
import { createSiteModule } from '../src/server/sites/index'

async function treeBytes(path: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    bytes += entry.isDirectory() ? await treeBytes(child) : (await stat(child)).size
  }
  return bytes
}

for (const totalBytes of [64 * 1024, 50 * 1024 * 1024]) {
  const directory = await mkdtemp(join(tmpdir(), 'agp-benchmark-'))
  const db = openDatabase(directory)
  const config = parseConfig({ DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
    CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'benchmark',
    ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'a'.repeat(32)}$${'b'.repeat(64)}` })
  const auth = createAuth(db, config)
  let peakStagedDiskBytes = 0
  const sites = await createSiteModule(config, db, { fault: async (point) => {
    if (point === 'after-stage') peakStagedDiskBytes = Math.max(peakStagedDiskBytes, await treeBytes(directory))
  } })
  try {
    const principal = { ownerId: auth.ownerId }
    const count = totalBytes > 1024 * 1024 ? 5 : 1
    const size = totalBytes / count
    const files = Array.from({ length: count }, (_, index) => ({ path: index ? `asset-${index}.txt` : 'index.html',
      maximumBytes: size, body: (async function* () {
        const chunk = Buffer.alloc(Math.min(size, 64 * 1024), 65)
        for (let offset = 0; offset < size; offset += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - offset))
      })() }))
    const started = performance.now()
    const { site } = await sites.createSite(principal, { operationId: randomUUID(), name: 'Publication measurement', files })
    const createMs = performance.now() - started
    const updateStarted = performance.now()
    await sites.writeFiles(principal, { siteId: site.id, expectedVersion: site.version, operationId: randomUUID(),
      files: [{ path: 'index.html', content: 'Updated index' }] })
    console.log(JSON.stringify({ totalBytes, createMs: Math.round(createMs), updateMs: Math.round(performance.now() - updateStarted),
      peakStagedDiskBytes, processMaxRssKiB: process.resourceUsage().maxRSS }))
  } finally { await sites.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
}
