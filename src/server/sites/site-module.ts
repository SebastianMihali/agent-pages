import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { contentType as formatContentType, lookup as lookupMimeType } from 'mime-types'
import type { AppConfig } from '../config'
import type { AppDatabase } from '../db'
import { DomainError, isDomainError, type Principal } from '../errors'
import { siteOrigin } from '../hosts'
import { audit } from '../audit'
import type {
  CreateResult, DeleteResult, FileInput, FileMutationResult, ManifestEntry, RevisionLease,
  SiteModule, SiteModuleOptions, SiteMutationResult, SiteView,
} from '.'
import { allowedDefaultExpiresInSeconds, initialDefaultExpiresInSeconds } from './expiration'

const receiptLifetimeMs = 24 * 60 * 60 * 1000
const pathLimitBytes = 512
const segmentLimit = 32
const supportedExtensions = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico', '.woff', '.woff2', '.txt', '.xml', '.webmanifest', '.map'])
const mimeTypeFor = (path: string) => formatContentType(lookupMimeType(path) || 'application/octet-stream') || 'application/octet-stream'
const comparePaths = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

async function writeFully(handle: FileHandle, bytes: Uint8Array) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) throw new Error('file write made no progress')
    offset += bytesWritten
  }
}

type SiteRow = {
  id: string; owner_id: string; name: string; visibility: 'private' | 'public'; visibility_generation: number; version: number
  active_revision_id: string; lifecycle: 'active' | 'tombstoned'; created_at_ms: number; updated_at_ms: number
  expires_at_ms: number | null; deletion_reason: 'explicit' | 'expired' | null; size_bytes: number; file_count: number
}
type ReceiptRow = { fingerprint_sha256: string; result_json: string }
type ReceiptHeader = { kind: string; target_site_id: string | null }
type CreateReceiptRow = { kind: string; result_json: string }
type StoredManifest = { revisionId: string; files: ManifestEntry[] }

class Mutex {
  private tail = Promise.resolve()
  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }
}

type LockEntry = { mutex: Mutex; users: number }

class MutationGate {
  private active = 0
  private readonly waiting: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  constructor(private readonly maximum: number, private readonly maximumQueued: number) {}
  private closing = false
  private drained: (() => void) | undefined
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new DomainError('BUSY', 'Site mutations are shutting down')
    if (this.active >= this.maximum) {
      if (this.waiting.length >= this.maximumQueued) throw new DomainError('BUSY', 'Too many site mutations are queued')
      await new Promise<void>((resolve, reject) => {
        const item = { resolve, reject, timer: setTimeout(() => {
          const index = this.waiting.indexOf(item)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(new DomainError('BUSY', 'Timed out waiting to start the site mutation'))
        }, 30_000) }
        this.waiting.push(item)
      })
    }
    this.active += 1
    try { return await work() }
    finally {
      this.active -= 1
      const next = this.waiting.shift()
      if (next) { clearTimeout(next.timer); next.resolve() }
      if (this.closing && this.active === 0) this.drained?.()
    }
  }
  async close() {
    this.closing = true
    for (const item of this.waiting.splice(0)) { clearTimeout(item.timer); item.reject(new DomainError('BUSY', 'Site mutations are shutting down')) }
    if (this.active === 0) return
    await new Promise<void>((resolve) => { this.drained = resolve })
  }
}

function migrate(sql: AppDatabase['sql']) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS site_ids (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY REFERENCES site_ids(id), owner_id TEXT NOT NULL, name TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('private','public')), visibility_generation INTEGER NOT NULL CHECK(visibility_generation >= 1),
      version INTEGER NOT NULL CHECK(version >= 1), active_revision_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','tombstoned')), deletion_reason TEXT CHECK(deletion_reason IN ('explicit','expired')),
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER, tombstoned_at_ms INTEGER,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), file_count INTEGER NOT NULL CHECK(file_count >= 0),
      cleanup_after_ms INTEGER, cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_error_category TEXT);
    CREATE INDEX IF NOT EXISTS sites_owner_list ON sites(owner_id,lifecycle,created_at_ms,id);
    CREATE INDEX IF NOT EXISTS sites_expiry ON sites(lifecycle,expires_at_ms);
    CREATE TABLE IF NOT EXISTS site_revisions (
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, id TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      file_count INTEGER NOT NULL CHECK(file_count >= 0), created_at_ms INTEGER NOT NULL, cleanup_after_ms INTEGER,
      cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_error_category TEXT, PRIMARY KEY(site_id,id));
    CREATE INDEX IF NOT EXISTS site_revisions_cleanup ON site_revisions(cleanup_after_ms);
    CREATE TABLE IF NOT EXISTS site_operation_receipts (
      owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL, target_site_id TEXT,
      fingerprint_sha256 TEXT NOT NULL, result_json TEXT NOT NULL, committed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY(owner_id,operation_id));
    CREATE INDEX IF NOT EXISTS site_operation_receipts_expiry ON site_operation_receipts(expires_at_ms);
    INSERT OR IGNORE INTO __migrations(name) VALUES ('0003_site_publication');
    CREATE TABLE IF NOT EXISTS owner_settings (
      owner_id TEXT PRIMARY KEY, default_expires_in_seconds INTEGER,
      updated_at_ms INTEGER NOT NULL,
      CHECK(default_expires_in_seconds IS NULL OR default_expires_in_seconds IN (86400,604800,2592000))
    );
    INSERT OR IGNORE INTO __migrations(name) VALUES ('0004_owner_settings');
  `)
}

function opaqueId() { return randomBytes(16).toString('hex') }
function canonicalPath(path: string) {
  if (typeof path !== 'string' || Buffer.byteLength(path) > pathLimitBytes || path.startsWith('/') || path.includes('\\') || path.includes('%') || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new DomainError('INVALID_PATH', 'File path is not a canonical relative POSIX path')
  }
  const segments = path.split('/')
  if (segments.length > segmentLimit || segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || segments[0] === '_agent') {
    throw new DomainError('INVALID_PATH', 'File path contains a forbidden segment')
  }
  if (!supportedExtensions.has(extname(path).toLowerCase())) throw new DomainError('UNSUPPORTED_MEDIA_TYPE', `Unsupported file extension for ${path}`)
  return path
}

function validateTree(paths: readonly string[]) {
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) throw new DomainError('INVALID_PATH', `Duplicate file path: ${path}`)
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) if (seen.has(parts.slice(0, index).join('/'))) throw new DomainError('INVALID_PATH', 'File and directory paths collide')
    for (const existing of seen) if (existing.startsWith(`${path}/`)) throw new DomainError('INVALID_PATH', 'File and directory paths collide')
    seen.add(path)
  }
}

function stableFingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function digestPairs(entries: readonly Readonly<{ path: string; digest: string }>[]) {
  return entries.map((entry) => [entry.path, entry.digest] as const).sort((left, right) => comparePaths(left[0], right[0]))
}
function textManifestEntries(files: readonly FileInput[]) {
  if (!files.every((file) => 'content' in file)) return undefined
  const entries = files.map((file) => ({
    path: canonicalPath(file.path),
    sizeBytes: Buffer.byteLength(file.content, 'utf8'),
    contentType: mimeTypeFor(file.path),
    digest: createHash('sha256').update(file.content, 'utf8').digest('hex'),
  }))
  validateTree(entries.map((entry) => entry.path))
  return entries.sort((left, right) => comparePaths(left.path, right.path))
}
function iso(milliseconds: number) { return new Date(milliseconds).toISOString() }
function parseCursor(value: string | undefined): unknown {
  if (!value) return undefined
  if (value.length > 4096) throw new DomainError('INVALID_INPUT', 'Cursor is invalid')
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) }
  catch { throw new DomainError('INVALID_INPUT', 'Cursor is invalid') }
}
function makeCursor(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url') }

export async function createSiteModule(config: AppConfig, database: AppDatabase, options: SiteModuleOptions = {}): Promise<SiteModule> {
  const { sql } = database
  migrate(sql)
  const now = () => (options.now?.() ?? new Date()).getTime()
  const gate = new MutationGate(config.limits.maxConcurrentMutations, config.limits.maxQueuedMutations)
  const locks = new Map<string, LockEntry>()
  const operationLocks = new Map<string, LockEntry>()
  const revisionGate = new Mutex()
  const quotaGate = new Mutex()
  const shutdown = new AbortController()
  const leases = new Map<string, number>()
  type PendingCleanup = { roots: Set<string>; releaseReservation: () => Promise<void> }
  const pendingCleanups = new Set<PendingCleanup>()
  let reservedActiveBytes = 0
  let reservedStoredBytes = 0
  let reservedSites = 0
  let reservedReceipts = 0
  // This installation has one owner. A shared budget covers all their keys,
  // sessions and transports without growing a map from caller-supplied IDs.
  let mutationWindowEnd = now() + 60_000
  let mutationAttempts = 0
  const withKeyLock = async <T>(map: Map<string, LockEntry>, key: string, work: () => Promise<T>) => {
    let entry = map.get(key)
    if (!entry) { entry = { mutex: new Mutex(), users: 0 }; map.set(key, entry) }
    entry.users += 1
    try { return await entry.mutex.run(work) }
    finally { entry.users -= 1; if (entry.users === 0) map.delete(key) }
  }
  const sitesRoot = join(config.dataDir, 'sites')
  const stagingRoot = join(config.dataDir, 'staging')
  await mkdir(sitesRoot, { recursive: true, mode: 0o700 })
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })

  const retryCleanup = async (pending: PendingCleanup) => {
    for (const root of [...pending.roots]) {
      try { await rm(root, { recursive: true, force: true }); pending.roots.delete(root) } catch { /* Retry on the next cleanup pass. */ }
    }
    if (pending.roots.size) return
    pendingCleanups.delete(pending)
    await pending.releaseReservation()
  }
  const discardArtifacts = async (roots: readonly string[], releaseReservation: () => Promise<void>) => {
    const pending = { roots: new Set(roots), releaseReservation }
    pendingCleanups.add(pending)
    await retryCleanup(pending)
  }

  const siteRow = (ownerId: string, siteId: string, includeExpired = false) => {
    const row = sql.prepare('SELECT * FROM sites WHERE id=? AND owner_id=?').get(siteId, ownerId) as SiteRow | undefined
    if (!row) throw new DomainError('NOT_FOUND', 'Site not found')
    if (row.lifecycle === 'tombstoned' && row.deletion_reason !== 'expired') throw new DomainError('NOT_FOUND', 'Site not found')
    if (!includeExpired && (row.lifecycle === 'tombstoned' || (row.expires_at_ms !== null && row.expires_at_ms <= now()))) throw new DomainError('SITE_EXPIRED', 'Site has expired')
    return row
  }
  const ensureMutable = (ownerId: string, siteId: string, expectedVersion: number, timestamp: number, allowExpired = false) => {
    const current = sql.prepare('SELECT * FROM sites WHERE id=? AND owner_id=?').get(siteId, ownerId) as SiteRow | undefined
    if (!current || (current.lifecycle === 'tombstoned' && current.deletion_reason !== 'expired')) throw new DomainError('NOT_FOUND', 'Site not found')
    if (!allowExpired && (current.lifecycle === 'tombstoned' || (current.expires_at_ms !== null && current.expires_at_ms <= timestamp))) throw new DomainError('SITE_EXPIRED', 'Site has expired')
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: current.version })
    return current
  }
  const view = (row: SiteRow): SiteView => ({
    id: row.id, name: row.name, visibility: row.visibility, version: row.version, revisionId: row.active_revision_id,
    url: siteOrigin(config, row.id), openUrl: `${config.appOrigin}/sites/${row.id}/open`, createdAt: iso(row.created_at_ms),
    updatedAt: iso(row.updated_at_ms), expiresAt: row.expires_at_ms === null ? null : iso(row.expires_at_ms), sizeBytes: row.size_bytes, fileCount: row.file_count,
  })
  const revisionPath = (siteId: string, revisionId: string) => join(sitesRoot, siteId, 'revisions', revisionId)
  // Revisions are immutable, so a validated manifest stays correct until the
  // revision is reclaimed. Every content request needs one; reading and
  // revalidating it from disk per request was the serving hot path.
  const manifestCache = new Map<string, StoredManifest>()
  const manifestCacheLimit = 64
  const manifestKey = (siteId: string, revisionId: string) => `${siteId}:${revisionId}`
  const forgetManifests = (siteId: string, revisionId?: string) => {
    if (revisionId !== undefined) { manifestCache.delete(manifestKey(siteId, revisionId)); return }
    for (const key of manifestCache.keys()) if (key.startsWith(`${siteId}:`)) manifestCache.delete(key)
  }
  const loadManifest = async (siteId: string, revisionId: string): Promise<StoredManifest> => {
    try {
      const parsed = JSON.parse(await readFile(join(revisionPath(siteId, revisionId), 'manifest.json'), 'utf8')) as StoredManifest
      if (parsed.revisionId !== revisionId || !Array.isArray(parsed.files)) throw new Error('bad manifest')
      for (const entry of parsed.files) {
        canonicalPath(entry.path)
        if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(entry.digest) || entry.contentType !== mimeTypeFor(entry.path)) throw new Error('bad manifest entry')
      }
      validateTree(parsed.files.map((entry) => entry.path))
      if (parsed.files.some((entry, index) => index > 0 && comparePaths(parsed.files[index - 1]!.path, entry.path) >= 0)) throw new Error('manifest is not canonically sorted')
      return parsed
    } catch (error) { throw new DomainError('STORAGE_UNAVAILABLE', 'A site revision is unavailable', undefined, { cause: error }) }
  }
  const readManifest = async (siteId: string, revisionId: string): Promise<StoredManifest> => {
    const cached = manifestCache.get(manifestKey(siteId, revisionId))
    if (cached) return cached
    const parsed = await loadManifest(siteId, revisionId)
    manifestCache.set(manifestKey(siteId, revisionId), parsed)
    if (manifestCache.size > manifestCacheLimit) manifestCache.delete(manifestCache.keys().next().value!)
    return parsed
  }
  const receipt = (ownerId: string, operationId: string, fingerprint: string) => {
    const row = sql.prepare('SELECT fingerprint_sha256,result_json FROM site_operation_receipts WHERE owner_id=? AND operation_id=?').get(ownerId, operationId) as ReceiptRow | undefined
    if (!row) return undefined
    if (row.fingerprint_sha256 !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Operation ID was already used with different input')
    return JSON.parse(row.result_json) as unknown
  }
  const receiptHeader = (ownerId: string, operationId: string) => sql.prepare('SELECT kind,target_site_id FROM site_operation_receipts WHERE owner_id=? AND operation_id=?')
    .get(ownerId, operationId) as ReceiptHeader | undefined
  const validateOperation = (operationId: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new DomainError('INVALID_INPUT', 'operationId must be a UUID')
  }
  const admitReceipt = () => quotaGate.run(async () => {
    const timestamp = now()
    sql.prepare('DELETE FROM site_operation_receipts WHERE expires_at_ms<=?').run(timestamp)
    const count = (sql.prepare('SELECT count(*) count FROM site_operation_receipts').get() as { count: number }).count
    if (count + reservedReceipts >= config.limits.maxIdempotencyReceipts) throw new DomainError('BUSY', 'Idempotency receipt capacity is full')
    reservedReceipts += 1
    let released = false
    return async () => quotaGate.run(async () => { if (!released) { released = true; reservedReceipts -= 1 } })
  })
  const saveReceipt = (ownerId: string, operationId: string, kind: string, target: string | null, fingerprint: string, result: unknown, timestamp: number) => {
    sql.prepare('INSERT INTO site_operation_receipts VALUES (?,?,?,?,?,?,?,?)').run(ownerId, operationId, kind, target, fingerprint, JSON.stringify(result), timestamp, timestamp + receiptLifetimeMs)
  }
  const stageInputs = async (files: readonly FileInput[], maximumUploadBytes?: number) => {
    // A failed cleanup must not grow an unbounded set of unaccounted roots.
    if (pendingCleanups.size) throw new DomainError('STORAGE_UNAVAILABLE', 'Storage cleanup must finish before accepting another revision')
    if (!files.length || files.length > config.limits.maxBatchFiles) throw new DomainError('INVALID_INPUT', 'File batch must be nonempty and within the configured limit')
    const normalized = files.map((file) => ({ ...file, path: canonicalPath(file.path) }))
    validateTree(normalized.map((file) => file.path))
    let upperBound = 0
    for (const file of normalized) {
      const maximum = 'content' in file ? Buffer.byteLength(file.content, 'utf8') : file.maximumBytes
      if (!Number.isSafeInteger(maximum) || maximum < 0) throw new DomainError('INVALID_INPUT', 'File maximumBytes is invalid')
      upperBound += Math.min(maximum, config.limits.maxFileBytes)
      if (!Number.isSafeInteger(upperBound)) throw new DomainError('PAYLOAD_TOO_LARGE', 'File batch is too large')
    }
    if (maximumUploadBytes !== undefined) {
      if (!Number.isSafeInteger(maximumUploadBytes) || maximumUploadBytes < 0) throw new DomainError('INVALID_INPUT', 'maximumUploadBytes is invalid')
      upperBound = Math.min(upperBound, maximumUploadBytes)
    }
    const root = join(stagingRoot, opaqueId())
    const entries: Array<ManifestEntry & { stagedPath: string }> = []
    let batchSize = 0
    const releaseInputReservation = await reserveQuota(0, 0, upperBound, false)
    try {
      await mkdir(join(root, 'uploads'), { recursive: true, mode: 0o700 })
      for (const file of normalized) {
        const destination = join(root, 'uploads', file.path)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        const hash = createHash('sha256')
        let size = 0
        if (!('content' in file) && (!Number.isSafeInteger(file.maximumBytes) || file.maximumBytes < 0)) throw new DomainError('INVALID_INPUT', 'File maximumBytes is invalid')
        const maximum = 'content' in file ? config.limits.maxFileBytes : Math.min(file.maximumBytes, config.limits.maxFileBytes)
        try {
          const source: AsyncIterable<Uint8Array> = 'content' in file
            ? (async function* () { yield Buffer.from(file.content, 'utf8') })()
            : file.body instanceof Uint8Array ? (async function* () { yield file.body as Uint8Array })() : file.body
          const iterator = source[Symbol.asyncIterator]()
          try {
            while (true) {
              const part = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
                const aborted = () => reject(new DomainError('BUSY', 'Site mutation was cancelled during shutdown'))
                if (shutdown.signal.aborted) { aborted(); return }
                shutdown.signal.addEventListener('abort', aborted, { once: true })
                iterator.next().then((value) => { shutdown.signal.removeEventListener('abort', aborted); resolve(value) }, (error: unknown) => { shutdown.signal.removeEventListener('abort', aborted); reject(error) })
              })
              if (part.done) break
              const chunk = part.value
              if (!(chunk instanceof Uint8Array)) throw new DomainError('INVALID_INPUT', 'File stream produced invalid bytes')
              size += chunk.byteLength
              if (size > maximum) throw new DomainError('PAYLOAD_TOO_LARGE', `File exceeds the configured limit: ${file.path}`)
              batchSize += chunk.byteLength
              if (maximumUploadBytes !== undefined && batchSize > maximumUploadBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 'File batch exceeds its admitted size')
              hash.update(chunk); await writeFully(handle, chunk)
            }
          } finally {
            if (shutdown.signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => undefined)
          }
          await handle.sync()
        } finally { await handle.close() }
        entries.push({ path: file.path, sizeBytes: size, contentType: mimeTypeFor(file.path), digest: hash.digest('hex'), stagedPath: destination })
      }
      return { root, entries, releaseInputReservation }
    } catch (error) {
      await discardArtifacts([root], releaseInputReservation)
      throw error
    }
  }
  const writeRevision = async (siteId: string, revisionId: string, stagingContainer: string, staging: Awaited<ReturnType<typeof stageInputs>> | null, manifest: ManifestEntry[], previous?: StoredManifest) => {
    const revisionStage = join(stagingContainer, 'revision')
    await mkdir(join(revisionStage, 'files'), { recursive: true, mode: 0o700 })
    const uploaded = new Map(staging?.entries.map((entry) => [entry.path, entry]))
    const directories = new Set([join(revisionStage, 'files')])
    const syncDirectory = async (path: string) => {
      const handle = await open(path, constants.O_RDONLY)
      try { await handle.sync() } finally { await handle.close() }
    }
    for (const entry of manifest) {
        await options.fault?.('before-revision-file-copy')
        const destination = join(revisionStage, 'files', entry.path)
        const destinationDirectory = dirname(destination)
        await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
        for (let directory = destinationDirectory;; directory = dirname(directory)) {
          directories.add(directory)
          if (directory === join(revisionStage, 'files')) break
        }
        const incoming = uploaded.get(entry.path)
        const source = incoming?.stagedPath ?? (previous ? join(revisionPath(siteId, previous.revisionId), 'files', entry.path) : undefined)
        if (!source) throw new DomainError('STORAGE_UNAVAILABLE', 'Revision source file is missing')
        const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
          try {
          const sourceInfo = await sourceHandle.stat()
          if (!sourceInfo.isFile() || sourceInfo.size !== entry.sizeBytes) throw new Error('unsafe revision source')
          const buffer = Buffer.allocUnsafe(64 * 1024)
          let position = 0
          while (position < sourceInfo.size) {
            if (shutdown.signal.aborted) throw new DomainError('BUSY', 'Site mutation was cancelled during shutdown')
            const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, sourceInfo.size - position), position)
            if (bytesRead === 0) throw new Error('revision source ended early')
            await writeFully(destinationHandle, buffer.subarray(0, bytesRead)); position += bytesRead
          }
          await destinationHandle.sync()
          } finally { await destinationHandle.close() }
        } finally { await sourceHandle.close() }
    }
    const manifestHandle = await open(join(revisionStage, 'manifest.json'), 'wx', 0o600)
    try { await manifestHandle.writeFile(JSON.stringify({ revisionId, files: manifest })); await manifestHandle.sync() } finally { await manifestHandle.close() }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory)
    await syncDirectory(revisionStage)
    await options.fault?.('after-stage')
    const final = revisionPath(siteId, revisionId)
    await mkdir(dirname(final), { recursive: true, mode: 0o700 })
    await rename(revisionStage, final)
    await syncDirectory(dirname(final))
    await syncDirectory(dirname(dirname(final)))
    await syncDirectory(sitesRoot)
    await options.fault?.('after-finalize')
    if (!staging) await rm(stagingContainer, { recursive: true, force: true })
    return final
  }
  const reserveQuota = async (siteSize: number, previousSize: number, storedBytes: number, creating: boolean) => quotaGate.run(async () => {
    if (siteSize > config.limits.maxSiteBytes) throw new DomainError('QUOTA_EXCEEDED', 'Site exceeds its size limit')
    const active = (sql.prepare("SELECT coalesce(sum(size_bytes),0) total FROM sites WHERE lifecycle='active'").get() as { total: number }).total
    const activeIncrease = Math.max(0, siteSize - previousSize)
    if (active + reservedActiveBytes + activeIncrease > config.limits.maxTotalSiteBytes) throw new DomainError('QUOTA_EXCEEDED', 'Total active site storage limit exceeded')
    const stored = (sql.prepare('SELECT coalesce(sum(size_bytes),0) total FROM site_revisions').get() as { total: number }).total
    if (stored + reservedStoredBytes + storedBytes > config.limits.maxStoredBytes) throw new DomainError('QUOTA_EXCEEDED', 'Stored content limit exceeded')
    if (creating) {
      const count = (sql.prepare('SELECT count(*) count FROM sites').get() as { count: number }).count
      if (count + reservedSites >= config.limits.maxSites) throw new DomainError('QUOTA_EXCEEDED', 'Site count limit exceeded')
    }
    const disk = await statfs(config.dataDir)
    if (disk.bavail * disk.bsize - reservedStoredBytes - storedBytes < config.limits.minFreeDiskBytes) throw new DomainError('QUOTA_EXCEEDED', 'Insufficient free disk reserve')
    reservedActiveBytes += activeIncrease; reservedStoredBytes += storedBytes; if (creating) reservedSites += 1
    let released = false
    return async () => quotaGate.run(async () => {
      if (released) return
      released = true; reservedActiveBytes -= activeIncrease; reservedStoredBytes -= storedBytes; if (creating) reservedSites -= 1
    })
  })
  const mutation = async <T>(principal: Principal, operationId: string, siteId: string | undefined, work: () => Promise<T>) => {
    validateOperation(operationId)
    if (now() >= mutationWindowEnd) { mutationWindowEnd = now() + 60_000; mutationAttempts = 0 }
    if (mutationAttempts >= config.limits.maxMutationsPerMinute) throw new DomainError('RATE_LIMITED', 'Site mutation limit reached; retry after the current minute')
    mutationAttempts++
    return gate.run(() => withKeyLock(operationLocks, `${principal.ownerId}:${operationId}`, () => siteId ? withKeyLock(locks, siteId, work) : work()))
      .catch((error: unknown) => {
        if (isDomainError(error)) throw error
        throw new DomainError('STORAGE_UNAVAILABLE', 'The site operation could not be completed', undefined, { cause: error })
      })
  }

  const ownerSettings = (ownerId: string) => {
    const row = sql.prepare('SELECT default_expires_in_seconds AS defaultExpiresInSeconds FROM owner_settings WHERE owner_id=?')
      .get(ownerId) as { defaultExpiresInSeconds: number | null } | undefined
    return row ?? { defaultExpiresInSeconds: initialDefaultExpiresInSeconds }
  }
  const getOwnerSettings: SiteModule['getOwnerSettings'] = async (principal) => ownerSettings(principal.ownerId)
  const setOwnerSettings: SiteModule['setOwnerSettings'] = async (principal, settings) => {
    if (!allowedDefaultExpiresInSeconds.has(settings.defaultExpiresInSeconds)) {
      throw new DomainError('INVALID_INPUT', 'Default expiration must be 86400, 604800, 2592000 seconds or null')
    }
    await revisionGate.run(async () => sql.prepare(`INSERT INTO owner_settings(owner_id,default_expires_in_seconds,updated_at_ms) VALUES (?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET default_expires_in_seconds=excluded.default_expires_in_seconds,updated_at_ms=excluded.updated_at_ms`)
      .run(principal.ownerId, settings.defaultExpiresInSeconds, now()))
    return { defaultExpiresInSeconds: settings.defaultExpiresInSeconds }
  }

  const createSite: SiteModule['createSite'] = (principal, command) => mutation(principal, command.operationId, undefined, async () => {
    const name = command.name.trim()
    if (!name || name.length > 100) throw new DomainError('INVALID_INPUT', 'Site name must contain 1 to 100 characters')
    const requestedExpires = command.expiresInSeconds
    if (requestedExpires !== undefined && requestedExpires !== null && (!Number.isInteger(requestedExpires) || requestedExpires < 60 || requestedExpires > 2_592_000)) {
      throw new DomainError('INVALID_INPUT', 'Expiration must be between 60 and 2592000 seconds')
    }
    const stored = sql.prepare('SELECT kind,result_json FROM site_operation_receipts WHERE owner_id=? AND operation_id=?')
      .get(principal.ownerId, command.operationId) as CreateReceiptRow | undefined
    if (stored && stored.kind !== 'create') throw new DomainError('IDEMPOTENCY_CONFLICT', 'Operation ID was already used with different input')
    const storedResult = stored ? JSON.parse(stored.result_json) as CreateResult : undefined
    const storedExpires = storedResult?.site.expiresAt === null ? null : storedResult
      ? (Date.parse(storedResult.site.expiresAt!) - Date.parse(storedResult.site.createdAt)) / 1000
      : undefined
    const replayExpires = requestedExpires === undefined ? storedExpires : requestedExpires
    const immediateEntries = textManifestEntries(command.files)
    if (immediateEntries && stored) {
      const immediateFingerprint = stableFingerprint({ kind: 'create', name, expires: replayExpires, files: digestPairs(immediateEntries) })
      const existing = receipt(principal.ownerId, command.operationId, immediateFingerprint) as CreateResult | undefined
      if (existing) return existing
    }
    const staged = await stageInputs(command.files, command.maximumUploadBytes)
    try {
      const sorted = staged.entries.map((entry) => ({ path: entry.path, sizeBytes: entry.sizeBytes, contentType: entry.contentType, digest: entry.digest })).sort((a, b) => comparePaths(a.path, b.path))
      validateTree(sorted.map((entry) => entry.path))
      if (!sorted.some((entry) => entry.path === 'index.html')) throw new DomainError('INVALID_INPUT', 'A site must contain index.html')
      if (stored) {
        const fingerprint = stableFingerprint({ kind: 'create', name, expires: replayExpires, files: digestPairs(sorted) })
        const existing = receipt(principal.ownerId, command.operationId, fingerprint) as CreateResult | undefined
        if (existing) return existing
      }
      const releaseReceipt = await admitReceipt()
      try {
      const total = sorted.reduce((sum, entry) => sum + entry.sizeBytes, 0)
      if (sorted.length > config.limits.maxFilesPerSite) throw new DomainError('QUOTA_EXCEEDED', 'Site file count limit exceeded')
      if (pendingCleanups.size) throw new DomainError('STORAGE_UNAVAILABLE', 'Storage cleanup must finish before accepting another revision')
      const releaseQuota = await reserveQuota(total, 0, total, true)
      let published = false; let cleanupOwnsQuota = false
      const siteId = opaqueId(); const revisionId = opaqueId()
      let fingerprint: string | undefined
      try {
      await writeRevision(siteId, revisionId, staged.root, staged, sorted)
      let result: CreateResult | undefined
      try {
        await revisionGate.run(async () => sql.transaction(() => {
          const timestamp = now()
          const expires = requestedExpires === undefined ? ownerSettings(principal.ownerId).defaultExpiresInSeconds : requestedExpires
          fingerprint = stableFingerprint({ kind: 'create', name, expires, files: digestPairs(sorted) })
          const row: SiteRow = { id: siteId, owner_id: principal.ownerId, name, visibility: 'private', visibility_generation: 1, version: 1,
            active_revision_id: revisionId, lifecycle: 'active', created_at_ms: timestamp, updated_at_ms: timestamp,
            expires_at_ms: expires === null ? null : timestamp + expires * 1000, deletion_reason: null, size_bytes: total, file_count: sorted.length }
          result = { site: view(row), operationId: command.operationId, operationExpiresAt: iso(timestamp + receiptLifetimeMs) }
          sql.prepare('INSERT INTO site_ids VALUES (?,?,?)').run(siteId, principal.ownerId, timestamp)
          sql.prepare("INSERT INTO sites(id,owner_id,name,visibility,visibility_generation,version,active_revision_id,lifecycle,created_at_ms,updated_at_ms,expires_at_ms,size_bytes,file_count) VALUES (?,?,?,'private',1,1,?,'active',?,?,?,?,?)")
            .run(siteId, principal.ownerId, name, revisionId, timestamp, timestamp, row.expires_at_ms, total, sorted.length)
          sql.prepare('INSERT INTO site_revisions(site_id,id,size_bytes,file_count,created_at_ms) VALUES (?,?,?,?,?)').run(siteId, revisionId, total, sorted.length, timestamp)
          saveReceipt(principal.ownerId, command.operationId, 'create', siteId, fingerprint, result, timestamp)
        })())
        published = true
      } catch (error) {
        const committed = fingerprint ? receipt(principal.ownerId, command.operationId, fingerprint) as CreateResult | undefined : undefined
        if (committed) { published = true; return committed }
        throw error
      }
      await options.fault?.('after-commit')
      if (!result) throw new Error('Site creation committed without a result')
      return result
      } catch (error) {
        if (!published) { cleanupOwnsQuota = true; await discardArtifacts([join(staged.root, 'revision'), join(sitesRoot, siteId)], releaseQuota) }
        throw error
      } finally { if (!cleanupOwnsQuota) await releaseQuota() }
      } finally { await releaseReceipt() }
    } finally { await discardArtifacts([staged.root], staged.releaseInputReservation) }
  })

  const changeFiles = (kind: 'write' | 'delete-files', principal: Principal, command: { operationId: string; siteId: string; expectedVersion: number; files?: readonly FileInput[]; paths?: readonly string[]; maximumUploadBytes?: number }): Promise<FileMutationResult> =>
    mutation(principal, command.operationId, command.siteId, async () => {
      const priorReceipt = receiptHeader(principal.ownerId, command.operationId)
      if (priorReceipt && (priorReceipt.kind !== kind || priorReceipt.target_site_id !== command.siteId)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Operation ID was already used with different input')
      const immediateEntries = command.files ? textManifestEntries(command.files) : undefined
      const immediateFingerprint = immediateEntries
        ? stableFingerprint({ kind, siteId: command.siteId, expectedVersion: command.expectedVersion, files: digestPairs(immediateEntries) })
        : undefined
      if (immediateFingerprint) {
        const existing = receipt(principal.ownerId, command.operationId, immediateFingerprint) as FileMutationResult | undefined
        if (existing) return existing
      }
      let authorizedRow: SiteRow | undefined
      if (!priorReceipt) {
        authorizedRow = siteRow(principal.ownerId, command.siteId)
        if (authorizedRow.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: authorizedRow.version })
      }
      if (immediateEntries && authorizedRow) {
        if (!immediateEntries.length || immediateEntries.length > config.limits.maxBatchFiles) throw new DomainError('INVALID_INPUT', 'File batch must be nonempty and within the configured limit')
        if (immediateEntries.some((entry) => entry.sizeBytes > config.limits.maxFileBytes)) throw new DomainError('PAYLOAD_TOO_LARGE', 'File exceeds the configured limit')
        const immediateSize = immediateEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
        if (command.maximumUploadBytes !== undefined && (!Number.isSafeInteger(command.maximumUploadBytes) || command.maximumUploadBytes < 0)) throw new DomainError('INVALID_INPUT', 'maximumUploadBytes is invalid')
        if (command.maximumUploadBytes !== undefined && immediateSize > command.maximumUploadBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 'File batch exceeds its admitted size')
        const current = await readManifest(authorizedRow.id, authorizedRow.active_revision_id)
        const currentFiles = new Map(current.files.map((entry) => [entry.path, entry]))
        if (immediateEntries.every((entry) => currentFiles.get(entry.path)?.digest === entry.digest)) {
          const releaseReceipt = await admitReceipt()
          try {
            const timestamp = now(); const result: FileMutationResult = { site: view(authorizedRow), changedPaths: [], deletedPaths: [],
              operationId: command.operationId, operationExpiresAt: iso(timestamp + receiptLifetimeMs) }
            await revisionGate.run(async () => sql.transaction(() => {
              ensureMutable(principal.ownerId, authorizedRow!.id, command.expectedVersion, timestamp)
              saveReceipt(principal.ownerId, command.operationId, kind, authorizedRow!.id, immediateFingerprint!, result, timestamp)
            })())
            return result
          } finally { await releaseReceipt() }
        }
      }
      const staged = command.files ? await stageInputs(command.files, command.maximumUploadBytes) : null
      try {
        const deletes = (command.paths ?? []).map(canonicalPath)
        if (kind === 'delete-files' && (!deletes.length || deletes.length > config.limits.maxBatchFiles)) throw new DomainError('INVALID_INPUT', 'Delete batch must be nonempty and within the configured limit')
        validateTree(deletes)
        const fileFingerprints = staged ? digestPairs(staged.entries) : deletes.slice().sort(comparePaths)
        const fingerprint = stableFingerprint({ kind, siteId: command.siteId, expectedVersion: command.expectedVersion, files: fileFingerprints })
        const existing = receipt(principal.ownerId, command.operationId, fingerprint) as FileMutationResult | undefined
        if (existing) return existing
        const releaseReceipt = await admitReceipt()
        try {
        const row = authorizedRow ?? siteRow(principal.ownerId, command.siteId)
        if (row.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: row.version })
        const previous = await readManifest(row.id, row.active_revision_id)
        const next = new Map(previous.files.map((entry) => [entry.path, entry]))
        const deletedPaths: string[] = []
        for (const path of deletes) if (next.delete(path)) deletedPaths.push(path)
        const changedPaths: string[] = []
        for (const entry of staged?.entries ?? []) {
          const prior = next.get(entry.path)
          if (!prior || prior.digest !== entry.digest) changedPaths.push(entry.path)
          const manifestEntry = { path: entry.path, sizeBytes: entry.sizeBytes, contentType: entry.contentType, digest: entry.digest }
          next.set(entry.path, manifestEntry)
        }
        const manifest = [...next.values()].sort((a, b) => comparePaths(a.path, b.path))
        validateTree(manifest.map((entry) => entry.path))
        if (!next.has('index.html')) throw new DomainError('INVALID_INPUT', 'A site must retain index.html')
        if (manifest.length > config.limits.maxFilesPerSite) throw new DomainError('QUOTA_EXCEEDED', 'Site file count limit exceeded')
        const total = manifest.reduce((sum, entry) => sum + entry.sizeBytes, 0)
        const timestamp = now(); const expiresAt = timestamp + receiptLifetimeMs
        if (row.expires_at_ms !== null && row.expires_at_ms <= timestamp) throw new DomainError('SITE_EXPIRED', 'Site has expired')
        if (!changedPaths.length && !deletedPaths.length) {
          const result: FileMutationResult = { site: view(row), changedPaths, deletedPaths, operationId: command.operationId, operationExpiresAt: iso(expiresAt) }
          await revisionGate.run(async () => sql.transaction(() => {
            ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp)
            saveReceipt(principal.ownerId, command.operationId, kind, row.id, fingerprint, result, timestamp)
          })())
          return result
        }
        if (pendingCleanups.size) throw new DomainError('STORAGE_UNAVAILABLE', 'Storage cleanup must finish before accepting another revision')
        const releaseQuota = await reserveQuota(total, row.size_bytes, total, false)
        let published = false; let cleanupOwnsQuota = false
        const revisionId = opaqueId(); const final = revisionPath(row.id, revisionId)
        const revisionWorkRoot = staged?.root ?? join(stagingRoot, opaqueId())
        try {
        await writeRevision(row.id, revisionId, revisionWorkRoot, staged, manifest, previous)
        const commitTimestamp = now()
        if (row.expires_at_ms !== null && row.expires_at_ms <= commitTimestamp) throw new DomainError('SITE_EXPIRED', 'Site has expired')
        const updated = { ...row, version: row.version + 1, active_revision_id: revisionId, updated_at_ms: commitTimestamp, size_bytes: total, file_count: manifest.length }
        const result: FileMutationResult = { site: view(updated), changedPaths: changedPaths.sort(), deletedPaths: deletedPaths.sort(), operationId: command.operationId, operationExpiresAt: iso(commitTimestamp + receiptLifetimeMs) }
        try {
          await revisionGate.run(async () => sql.transaction(() => {
            sql.prepare('INSERT INTO site_revisions(site_id,id,size_bytes,file_count,created_at_ms) VALUES (?,?,?,?,?)').run(row.id, revisionId, total, manifest.length, commitTimestamp)
            const changed = sql.prepare("UPDATE sites SET active_revision_id=?,version=version+1,updated_at_ms=?,size_bytes=?,file_count=? WHERE id=? AND owner_id=? AND lifecycle='active' AND version=? AND (expires_at_ms IS NULL OR expires_at_ms>?)")
              .run(revisionId, commitTimestamp, total, manifest.length, row.id, principal.ownerId, command.expectedVersion, commitTimestamp)
            if (changed.changes !== 1) ensureMutable(principal.ownerId, row.id, command.expectedVersion, commitTimestamp)
            sql.prepare('UPDATE site_revisions SET cleanup_after_ms=? WHERE site_id=? AND id=?').run(commitTimestamp, row.id, row.active_revision_id)
            saveReceipt(principal.ownerId, command.operationId, kind, row.id, fingerprint, result, commitTimestamp)
          })())
          published = true
        } catch (error) {
          const committed = receipt(principal.ownerId, command.operationId, fingerprint) as FileMutationResult | undefined
          if (committed) { published = true; return committed }
          throw error
        }
        await options.fault?.('after-commit')
        return result
        } catch (error) {
          if (!published) {
            cleanupOwnsQuota = true
            await discardArtifacts(staged ? [join(staged.root, 'revision'), final] : [revisionWorkRoot, final], releaseQuota)
          }
          throw error
        } finally { if (!cleanupOwnsQuota) await releaseQuota() }
        } finally { await releaseReceipt() }
      } finally { if (staged) await discardArtifacts([staged.root], staged.releaseInputReservation) }
    })

  const setVisibility: SiteModule['setVisibility'] = (principal, command) => mutation(principal, command.operationId, command.siteId, async () => {
    if (!['private', 'public'].includes(command.visibility)) throw new DomainError('INVALID_INPUT', 'Visibility must be private or public')
    const fingerprint = stableFingerprint({ kind: 'visibility', siteId: command.siteId, expectedVersion: command.expectedVersion, visibility: command.visibility })
    const existing = receipt(principal.ownerId, command.operationId, fingerprint) as SiteMutationResult | undefined
    if (existing) return existing
    const releaseReceipt = await admitReceipt()
    try {
    const row = siteRow(principal.ownerId, command.siteId)
    if (row.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: row.version })
    const timestamp = now(); const changed = row.visibility !== command.visibility
    const updated = { ...row, visibility: command.visibility, version: changed ? row.version + 1 : row.version, updated_at_ms: changed ? timestamp : row.updated_at_ms,
      visibility_generation: row.visibility === 'public' && command.visibility === 'private' ? row.visibility_generation + 1 : row.visibility_generation }
    const result: SiteMutationResult = { site: view(updated), operationId: command.operationId, operationExpiresAt: iso(timestamp + receiptLifetimeMs) }
    await revisionGate.run(async () => sql.transaction(() => {
      ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp)
      if (changed) {
        const update = sql.prepare("UPDATE sites SET visibility=?,visibility_generation=?,version=?,updated_at_ms=? WHERE id=? AND owner_id=? AND lifecycle='active' AND version=? AND (expires_at_ms IS NULL OR expires_at_ms>?)")
          .run(updated.visibility, updated.visibility_generation, updated.version, updated.updated_at_ms, row.id, principal.ownerId, row.version, timestamp)
        if (update.changes !== 1) ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp)
      }
      saveReceipt(principal.ownerId, command.operationId, 'visibility', row.id, fingerprint, result, timestamp)
    })())
    if (changed) audit({ event: 'site_visibility_changed', ownerId: principal.ownerId, siteId: row.id, operationId: command.operationId, visibility: command.visibility })
    return result
    } finally { await releaseReceipt() }
  })

  const setExpiration: SiteModule['setExpiration'] = (principal, command) => mutation(principal, command.operationId, command.siteId, async () => {
    const seconds = command.expiresInSeconds
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 60 || seconds > 2_592_000)) throw new DomainError('INVALID_INPUT', 'Expiration must be between 60 and 2592000 seconds or null')
    const fingerprint = stableFingerprint({ kind: 'expiration', siteId: command.siteId, expectedVersion: command.expectedVersion, expiresInSeconds: seconds })
    const existing = receipt(principal.ownerId, command.operationId, fingerprint) as SiteMutationResult | undefined
    if (existing) return existing
    const releaseReceipt = await admitReceipt()
    try {
    const row = siteRow(principal.ownerId, command.siteId)
    if (row.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: row.version })
    const timestamp = now()
    const expiresAt = seconds === null ? null : timestamp + seconds * 1000
    const changed = row.expires_at_ms !== expiresAt
    const updated = { ...row, expires_at_ms: expiresAt, version: changed ? row.version + 1 : row.version, updated_at_ms: changed ? timestamp : row.updated_at_ms }
    const result: SiteMutationResult = { site: view(updated), operationId: command.operationId, operationExpiresAt: iso(timestamp + receiptLifetimeMs) }
    await revisionGate.run(async () => sql.transaction(() => {
      ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp)
      if (changed) {
        const update = sql.prepare("UPDATE sites SET expires_at_ms=?,version=?,updated_at_ms=? WHERE id=? AND owner_id=? AND lifecycle='active' AND version=? AND (expires_at_ms IS NULL OR expires_at_ms>?)")
          .run(updated.expires_at_ms, updated.version, updated.updated_at_ms, row.id, principal.ownerId, row.version, timestamp)
        if (update.changes !== 1) ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp)
      }
      saveReceipt(principal.ownerId, command.operationId, 'expiration', row.id, fingerprint, result, timestamp)
    })())
    return result
    } finally { await releaseReceipt() }
  })

  const deleteSite: SiteModule['deleteSite'] = (principal, command) => mutation(principal, command.operationId, command.siteId, async () => {
    const fingerprint = stableFingerprint({ kind: 'delete-site', siteId: command.siteId, expectedVersion: command.expectedVersion })
    const existing = receipt(principal.ownerId, command.operationId, fingerprint) as DeleteResult | undefined
    if (existing) return existing
    const releaseReceipt = await admitReceipt()
    try {
    const row = siteRow(principal.ownerId, command.siteId, true)
    if (row.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Site version does not match', { currentVersion: row.version })
    const timestamp = now()
    const result: DeleteResult = { siteId: row.id, version: row.version + 1, deleted: true, cleanupPending: true, operationId: command.operationId, operationExpiresAt: iso(timestamp + receiptLifetimeMs) }
    await revisionGate.run(async () => sql.transaction(() => {
      ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp, true)
      const update = sql.prepare("UPDATE sites SET lifecycle='tombstoned',deletion_reason='explicit',tombstoned_at_ms=?,cleanup_after_ms=?,version=version+1,visibility_generation=visibility_generation+1,updated_at_ms=? WHERE id=? AND owner_id=? AND (lifecycle='active' OR deletion_reason='expired') AND version=?")
        .run(timestamp, timestamp, timestamp, row.id, principal.ownerId, row.version)
      if (update.changes !== 1) ensureMutable(principal.ownerId, row.id, command.expectedVersion, timestamp, true)
      saveReceipt(principal.ownerId, command.operationId, 'delete-site', row.id, fingerprint, result, timestamp)
    })())
    audit({ event: 'site_deleted', ownerId: principal.ownerId, siteId: row.id, operationId: command.operationId })
    return result
    } finally { await releaseReceipt() }
  })

  // The lease is taken under the revision gate so cleanup cannot reclaim the
  // revision; the manifest is then read outside the gate, off the serving hot path.
  const acquireRevision = async (select: () => Readonly<{ row: SiteRow; revisionId: string }>): Promise<RevisionLease> => {
    const { row, revisionId, key } = await revisionGate.run(async () => {
      const selected = select()
      const exists = sql.prepare('SELECT 1 FROM site_revisions WHERE site_id=? AND id=?').get(selected.row.id, selected.revisionId)
      if (!exists) throw new DomainError('REVISION_UNAVAILABLE', 'Revision is no longer retained')
      const key = `${selected.row.id}:${selected.revisionId}`
      leases.set(key, (leases.get(key) ?? 0) + 1)
      return { ...selected, key }
    })
    let released = false
    const release = async () => revisionGate.run(async () => { if (!released) { released = true; const count = (leases.get(key) ?? 1) - 1; if (count) leases.set(key, count); else leases.delete(key) } })
    let manifest: StoredManifest
    try { manifest = await readManifest(row.id, revisionId) }
    catch (error) { await release(); throw error }
    return {
      site: { id: row.id, ownerId: row.owner_id, visibility: row.visibility, visibilityGeneration: row.visibility_generation, expiresAt: row.expires_at_ms === null ? null : new Date(row.expires_at_ms) },
      revisionId, manifest: manifest.files, release,
      async open(path) {
        if (released) throw new DomainError('REVISION_UNAVAILABLE', 'Revision lease has been released')
        let canonical: string
        try { canonical = canonicalPath(path) }
        catch (error) { await release(); throw error }
        const entry = manifest.files.find((item) => item.path === canonical)
        if (!entry) { await release(); throw new DomainError('NOT_FOUND', 'File not found') }
        let fileHandle: Awaited<ReturnType<typeof open>>
        try {
          fileHandle = await revisionGate.run(async () => {
            const current = sql.prepare("SELECT visibility_generation,expires_at_ms FROM sites WHERE id=? AND lifecycle='active'").get(row.id) as { visibility_generation: number; expires_at_ms: number | null } | undefined
            if (!current || current.visibility_generation !== row.visibility_generation || (current.expires_at_ms !== null && current.expires_at_ms <= now())) {
              throw new DomainError('NOT_FOUND', 'Site not found')
            }
            return open(join(revisionPath(row.id, revisionId), 'files', canonical), constants.O_RDONLY | constants.O_NOFOLLOW)
          })
        } catch (error) {
          await release()
          if (isDomainError(error)) throw error
          throw new DomainError('STORAGE_UNAVAILABLE', 'A site revision file is unavailable', undefined, { cause: error })
        }
        const node = fileHandle.createReadStream()
        const body = Readable.toWeb(node) as ReadableStream<Uint8Array>
        const reader = body.getReader()
        const releasing = new ReadableStream<Uint8Array>({
          async pull(controller) { try { const part = await reader.read(); if (part.done) { controller.close(); await release() } else controller.enqueue(part.value) } catch (error) { controller.error(error); await release() } },
          async cancel(reason) { await reader.cancel(reason); await release() },
        })
        return { ...entry, revisionId, body: releasing }
      },
    }
  }

  const runCleanup: SiteModule['runCleanup'] = async (at = new Date(now())) => revisionGate.run(async () => {
    const timestamp = at.getTime(); let removedRevisions = 0; let removedSites = 0
    for (const pending of [...pendingCleanups]) await retryCleanup(pending)
    sql.prepare("UPDATE sites SET lifecycle='tombstoned',deletion_reason='expired',tombstoned_at_ms=?,cleanup_after_ms=?,version=version+1,visibility_generation=visibility_generation+1,updated_at_ms=? WHERE lifecycle='active' AND expires_at_ms IS NOT NULL AND expires_at_ms<=?")
      .run(timestamp, timestamp, timestamp, timestamp)
    const retired = sql.prepare("SELECT r.site_id,r.id,r.cleanup_attempts FROM site_revisions r JOIN sites s ON s.id=r.site_id WHERE r.cleanup_after_ms<=? AND r.id<>s.active_revision_id AND s.lifecycle='active' LIMIT 100").all(timestamp) as Array<{ site_id: string; id: string; cleanup_attempts: number }>
    for (const item of retired) {
      if (leases.has(`${item.site_id}:${item.id}`)) continue
      try { await rm(revisionPath(item.site_id, item.id), { recursive: true, force: true }); sql.prepare('DELETE FROM site_revisions WHERE site_id=? AND id=?').run(item.site_id, item.id); forgetManifests(item.site_id, item.id); removedRevisions += 1 }
      catch { const backoff = Math.min(3_600_000, 1000 * 2 ** Math.min(item.cleanup_attempts, 12)); sql.prepare("UPDATE site_revisions SET cleanup_attempts=cleanup_attempts+1,cleanup_after_ms=?,cleanup_error_category='filesystem' WHERE site_id=? AND id=?").run(timestamp + backoff, item.site_id, item.id) }
    }
    const tombstones = sql.prepare("SELECT id,active_revision_id,cleanup_attempts FROM sites WHERE lifecycle='tombstoned' AND cleanup_after_ms<=? LIMIT 100").all(timestamp) as Array<{ id: string; active_revision_id: string; cleanup_attempts: number }>
    for (const item of tombstones) {
      const hasLease = [...leases.keys()].some((key) => key.startsWith(`${item.id}:`))
      if (hasLease) continue
      try { await rm(join(sitesRoot, item.id), { recursive: true, force: true }); sql.prepare('DELETE FROM sites WHERE id=?').run(item.id); forgetManifests(item.id); removedSites += 1 }
      catch { const backoff = Math.min(3_600_000, 1000 * 2 ** Math.min(item.cleanup_attempts, 12)); sql.prepare("UPDATE sites SET cleanup_attempts=cleanup_attempts+1,cleanup_after_ms=?,cleanup_error_category='filesystem' WHERE id=?").run(timestamp + backoff, item.id) }
    }
    return { removedRevisions, removedSites }
  })

  const recover = async () => {
    await rm(stagingRoot, { recursive: true, force: true }); await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    const rows = sql.prepare("SELECT * FROM sites WHERE lifecycle='active'").all() as SiteRow[]
    for (const row of rows) {
      const manifest = await readManifest(row.id, row.active_revision_id)
      if (manifest.files.length !== row.file_count || manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) !== row.size_bytes) throw new Error(`Active revision metadata is inconsistent for site ${row.id}`)
      for (const file of manifest.files) {
        const handle = await open(join(revisionPath(row.id, row.active_revision_id), 'files', file.path), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size !== file.sizeBytes) throw new Error(`Active revision file is inconsistent for site ${row.id}`)
          const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0
          while (position < info.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position)
            if (bytesRead === 0) throw new Error(`Active revision file ended early for site ${row.id}`)
            digest.update(buffer.subarray(0, bytesRead)); position += bytesRead
          }
          if (digest.digest('hex') !== file.digest) throw new Error(`Active revision digest is inconsistent for site ${row.id}`)
        } finally { await handle.close() }
      }
    }
    const siteDirs = await readdir(sitesRoot, { withFileTypes: true })
    for (const siteDir of siteDirs) {
      if (!siteDir.isDirectory() || !/^[a-f0-9]{32}$/.test(siteDir.name)) continue
      const revisionsDir = join(sitesRoot, siteDir.name, 'revisions')
      let dirs: Dirent[]
      try { dirs = await readdir(revisionsDir, { withFileTypes: true }) } catch { continue }
      for (const revision of dirs) if (revision.isDirectory() && !sql.prepare('SELECT 1 FROM site_revisions WHERE site_id=? AND id=?').get(siteDir.name, revision.name)) await rm(join(revisionsDir, revision.name), { recursive: true, force: true })
    }
    await runCleanup(new Date(now()))
  }

  return {
    getOwnerSettings, setOwnerSettings,
    createSite,
    async listSites(principal, query = {}) {
      const requestedLimit = query.limit ?? 50
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new DomainError('INVALID_INPUT', 'List limit is invalid')
      const limit = Math.min(requestedLimit, 50)
      const cursor = parseCursor(query.cursor) as { ownerId?: string; createdAt?: number; id?: string } | undefined
      if (cursor && (cursor.ownerId !== principal.ownerId || typeof cursor.createdAt !== 'number' || typeof cursor.id !== 'string')) throw new DomainError('INVALID_INPUT', 'Cursor scope is invalid')
      const rows = sql.prepare(`SELECT * FROM sites WHERE owner_id=? AND (lifecycle='active' OR deletion_reason='expired') ${cursor ? 'AND (created_at_ms<? OR (created_at_ms=? AND id<?))' : ''} ORDER BY created_at_ms DESC,id DESC LIMIT ?`)
        .all(...(cursor ? [principal.ownerId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1] : [principal.ownerId, limit + 1])) as SiteRow[]
      const page = rows.slice(0, limit); const last = page.at(-1)
      return { sites: page.map(view), cursor: rows.length > limit && last ? makeCursor({ ownerId: principal.ownerId, createdAt: last.created_at_ms, id: last.id }) : null }
    },
    async getSite(principal, siteId) { return view(siteRow(principal.ownerId, siteId, true)) },
    writeFiles: (principal, command) => changeFiles('write', principal, { ...command, files: command.files }),
    deleteFiles: (principal, command) => changeFiles('delete-files', principal, { ...command, paths: command.paths }),
    setVisibility, setExpiration, deleteSite,
    async listFiles(principal, query) {
      const lease = await acquireRevision(() => {
        const row = siteRow(principal.ownerId, query.siteId)
        return { row, revisionId: query.revisionId ?? row.active_revision_id }
      })
      try {
        await options.fault?.('after-list-lease')
        const requestedLimit = query.limit ?? 100
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new DomainError('INVALID_INPUT', 'List limit is invalid')
        const limit = Math.min(requestedLimit, 100)
        const cursor = parseCursor(query.cursor) as { ownerId?: string; siteId?: string; revisionId?: string; path?: string } | undefined
        if (cursor && (cursor.ownerId !== principal.ownerId || cursor.siteId !== query.siteId || cursor.revisionId !== lease.revisionId || typeof cursor.path !== 'string')) throw new DomainError('INVALID_INPUT', 'Cursor scope is invalid')
        const found = cursor ? lease.manifest.findIndex((file) => file.path > cursor.path!) : 0
        const start = found < 0 ? lease.manifest.length : found
        const files = lease.manifest.slice(start, start + limit); const last = files.at(-1)
        return { revisionId: lease.revisionId, files, cursor: start + limit < lease.manifest.length && last ? makeCursor({ ownerId: principal.ownerId, siteId: query.siteId, revisionId: lease.revisionId, path: last.path }) : null }
      } finally { await lease.release() }
    },
    async openOwnedFile(principal, query) {
      const lease = await acquireRevision(() => {
        const row = siteRow(principal.ownerId, query.siteId)
        return { row, revisionId: query.revisionId ?? row.active_revision_id }
      })
      return lease.open(query.path)
    },
    async acquireActiveRevision(siteId, at = new Date(now())) {
      return acquireRevision(() => {
        const row = sql.prepare("SELECT * FROM sites WHERE id=? AND lifecycle='active'").get(siteId) as SiteRow | undefined
        if (!row || (row.expires_at_ms !== null && row.expires_at_ms <= at.getTime())) throw new DomainError('NOT_FOUND', 'Site not found')
        return { row, revisionId: row.active_revision_id }
      })
    },
    recover, runCleanup,
    async close() { shutdown.abort(); await gate.close() },
  }
}
