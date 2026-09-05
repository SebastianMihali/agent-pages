import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

const mib = 1024 * 1024
const positive = (fallback: number) => z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER / mib).default(fallback)
const envSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  APP_ORIGIN: z.url(),
  CONTENT_BASE_DOMAIN: z.string().min(1).max(253),
  DATA_DIR: z.string().min(1).default('./.data'),
  ADMIN_USERNAME: z.string().trim().min(1).max(100),
  ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MAX_SITE_SIZE_MB: positive(50),
  MAX_FILE_SIZE_MB: positive(20),
  MAX_FILES_PER_SITE: positive(500),
  MAX_SITES: positive(100),
  MAX_TOTAL_SITE_SIZE_MB: positive(1024),
  MAX_STORED_SIZE_MB: positive(3072),
  MIN_FREE_DISK_MB: positive(256),
  MAX_BATCH_FILES: positive(100),
  MAX_JSON_BODY_MB: positive(2),
  MAX_MULTIPART_BODY_MB: positive(25),
  MAX_MCP_TEXT_BYTES: positive(65536),
  MAX_CONCURRENT_MUTATIONS: positive(2),
  MAX_QUEUED_MUTATIONS: positive(16),
  MAX_MUTATIONS_PER_MINUTE: positive(30),
  MAX_IDEMPOTENCY_RECEIPTS: positive(100000),
  MAX_LOGIN_FAILURES_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(5),
  MAX_LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(60),
  MAX_CONCURRENT_PASSWORD_VERIFICATIONS: z.coerce.number().int().min(1).max(8).default(2),
})

export function parseConfig(input: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(input)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    // Zod's complete diagnostics may include credential input; report field names only.
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`)
  }
  const env = parsed.data
  const app = new URL(env.APP_ORIGIN)
  const domain = env.CONTENT_BASE_DOMAIN
  const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/
  if (!hostname.test(domain) || !hostname.test(app.hostname) ||
      app.username || app.password || app.pathname !== '/' || app.search || app.hash ||
      !['https:', 'http:'].includes(app.protocol)) {
    throw new Error('APP_ORIGIN and CONTENT_BASE_DOMAIN must be canonical hostnames without paths or credentials')
  }
  if (app.hostname === domain || app.hostname.endsWith(`.${domain}`) || domain.endsWith(`.${app.hostname}`)) {
    throw new Error('Application and content hostnames must not overlap')
  }
  if (app.protocol !== 'https:' && (env.NODE_ENV === 'production' ||
      !app.hostname.endsWith('.localhost') || !domain.endsWith('.localhost'))) {
    throw new Error('HTTP is allowed only for distinct development .localhost hostnames')
  }
  if (env.NODE_ENV === 'production' && !isAbsolute(env.DATA_DIR)) {
    throw new Error('Production DATA_DIR must be an absolute persistent directory')
  }
  if (env.MAX_FILE_SIZE_MB > env.MAX_SITE_SIZE_MB ||
      env.MAX_SITE_SIZE_MB > env.MAX_TOTAL_SITE_SIZE_MB ||
      env.MAX_TOTAL_SITE_SIZE_MB > env.MAX_STORED_SIZE_MB ||
      env.MAX_BATCH_FILES > env.MAX_FILES_PER_SITE) {
    throw new Error('File, site, total storage and batch limits must be coherent')
  }
  return {
    appOrigin: app.origin,
    appAuthority: app.host,
    contentBaseDomain: domain,
    contentPort: app.port,
    production: env.NODE_ENV === 'production',
    secureCookies: app.protocol === 'https:',
    dataDir: resolve(env.DATA_DIR),
    adminUsername: env.ADMIN_USERNAME,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    port: env.PORT,
    authLimits: {
      maxLoginFailuresPerMinute: env.MAX_LOGIN_FAILURES_PER_MINUTE,
      maxLoginAttemptsPerMinute: env.MAX_LOGIN_ATTEMPTS_PER_MINUTE,
      maxConcurrentVerifications: env.MAX_CONCURRENT_PASSWORD_VERIFICATIONS,
    },
    limits: {
      maxSiteBytes: env.MAX_SITE_SIZE_MB * mib,
      maxFileBytes: env.MAX_FILE_SIZE_MB * mib,
      maxFilesPerSite: env.MAX_FILES_PER_SITE,
      maxSites: env.MAX_SITES,
      maxTotalSiteBytes: env.MAX_TOTAL_SITE_SIZE_MB * mib,
      maxStoredBytes: env.MAX_STORED_SIZE_MB * mib,
      minFreeDiskBytes: env.MIN_FREE_DISK_MB * mib,
      maxBatchFiles: env.MAX_BATCH_FILES,
      maxJsonBodyBytes: env.MAX_JSON_BODY_MB * mib,
      maxMultipartBodyBytes: env.MAX_MULTIPART_BODY_MB * mib,
      maxMcpTextBytes: env.MAX_MCP_TEXT_BYTES,
      maxConcurrentMutations: env.MAX_CONCURRENT_MUTATIONS,
      maxQueuedMutations: env.MAX_QUEUED_MUTATIONS,
      maxMutationsPerMinute: env.MAX_MUTATIONS_PER_MINUTE,
      maxIdempotencyReceipts: env.MAX_IDEMPOTENCY_RECEIPTS,
    },
  }
}

export type AppConfig = ReturnType<typeof parseConfig>
