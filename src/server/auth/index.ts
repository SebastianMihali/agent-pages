import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { audit } from '../audit'
import type { AppDatabase } from '../db'
import { DomainError, isDomainError, requireOrigin, type Principal } from '../errors'
import { verifyPassword } from './password'

export type Session = { id: string; ownerId: string; expiresAt: number; csrfToken: string }
export type AuthConfig = { adminUsername: string; adminPasswordHash: string; appOrigin: string }
export type AuthOptions = {
  now?: () => number
  maxConcurrentVerifications?: number
  maxLoginFailuresPerMinute?: number
  maxLoginAttemptsPerMinute?: number
  maxLoginChallenges?: number
  maxSessions?: number
}
export type LoginInput = { username: string; password: string; challengeToken: string; csrfToken: string; ip: string; previousSessionToken?: string }
export type KeySummary = { id: string; label: string; prefix: string; createdAt: string }

const token = () => randomBytes(32).toString('base64url')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const csrf = (value: string) => hash(`agent-pages-csrf:${value}`)
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const denied = () => new DomainError('UNAUTHENTICATED', 'Authentication failed')
function matchesCsrf(value: string, supplied: string) {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(csrf(value), 'hex'), Buffer.from(supplied, 'hex'))
}

export function createAuth(db: AppDatabase, config: AuthConfig, options: AuthOptions = {}) {
  const { sql } = db
  const now = options.now ?? Date.now
  const maxFailures = options.maxLoginFailuresPerMinute ?? 5
  const maxAttempts = options.maxLoginAttemptsPerMinute ?? 60
  const maxVerifications = options.maxConcurrentVerifications ?? 2
  const maxChallenges = options.maxLoginChallenges ?? 1000
  const maxSessions = options.maxSessions ?? 100
  for (const [value, maximum] of [[maxFailures, 100], [maxAttempts, 10000], [maxVerifications, 8], [maxChallenges, 10000], [maxSessions, 1000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid authentication resource limit')
  }
  let windowEnd = now() + 60_000
  let challengeWindowEnd = now() + 60_000
  let challengesIssued = 0
  let attempts = 0
  let activeVerifications = 0
  let rateLimitAuditedUntil = 0
  const failures = new Map<string, { count: number }>()

  function admitLogin(input: LoginInput) {
    if (now() >= windowEnd) {
      windowEnd = now() + 60_000
      attempts = 0
      failures.clear()
    }
    if (attempts >= maxAttempts) throw new DomainError('RATE_LIMITED', 'Login temporarily unavailable')
    attempts++
    if (typeof input.username !== 'string' || input.username.length > 100 ||
        typeof input.password !== 'string' || typeof input.ip !== 'string' || input.ip.length > 128) throw denied()
    const accountIp = hash(`${input.username.trim().normalize('NFKC').toLowerCase()}\n${input.ip}`)
    const state = failures.get(accountIp) ?? { count: 0 }
    if (state.count >= maxFailures) throw new DomainError('RATE_LIMITED', 'Login temporarily unavailable')
    state.count++
    failures.set(accountIp, state)
    return state
  }
  sql.transaction(() => {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_owner (
        id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton = 1), username TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES auth_owner(id),
        token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_login_challenges (
        token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_api_keys (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES auth_owner(id),
        token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, prefix TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_login_challenges(expires_at);
    `)
    sql.prepare('INSERT OR IGNORE INTO auth_owner (id, singleton, username) VALUES (?, 1, ?)').run(randomUUID(), config.adminUsername)
    sql.prepare('UPDATE auth_owner SET username = ? WHERE singleton = 1').run(config.adminUsername)
    // Dependent site tickets/grants reference sessions with ON DELETE CASCADE.
    sql.prepare('DELETE FROM auth_sessions').run()
    sql.prepare('DELETE FROM auth_login_challenges').run()
    sql.prepare('INSERT OR IGNORE INTO __migrations (name) VALUES (?)').run('auth-001')
  })()
  const ownerId = (sql.prepare('SELECT id FROM auth_owner WHERE singleton = 1').get() as { id: string }).id

  function getSession(value: string | null): Session | null {
    if (!validToken(value)) return null
    const row = sql.prepare('SELECT id, owner_id AS ownerId, expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hash(value), now()) as Omit<Session, 'csrfToken'> | undefined
    return row ? { ...row, csrfToken: csrf(value) } : null
  }
  function requireSession(value: string | null): Session {
    const session = getSession(value)
    if (!session) throw denied()
    return session
  }
  function logout(value: string | null) {
    if (validToken(value)) sql.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash(value))
  }
  function requireOwner(principal: Principal) {
    if (principal.ownerId !== ownerId) throw new DomainError('NOT_FOUND', 'Not found')
  }
  function sweepExpired() {
    sql.transaction(() => {
      sql.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now())
      sql.prepare('DELETE FROM auth_login_challenges WHERE expires_at <= ?').run(now())
    })()
  }

  return {
    ownerId,
    createLoginChallenge(existingToken?: string | null) {
      sweepExpired()
      if (validToken(existingToken)) {
        const existing = sql.prepare('SELECT expires_at AS expiresAt FROM auth_login_challenges WHERE token_hash = ? AND expires_at > ?')
          .get(hash(existingToken), now()) as { expiresAt: number } | undefined
        if (existing) return { token: existingToken, csrfToken: csrf(existingToken), expiresAt: existing.expiresAt }
      }
      if (now() >= challengeWindowEnd) {
        challengeWindowEnd = now() + 60_000
        challengesIssued = 0
      }
      if (challengesIssued >= maxAttempts) throw new DomainError('RATE_LIMITED', 'Login temporarily unavailable')
      const count = sql.prepare('SELECT COUNT(*) AS count FROM auth_login_challenges').get() as { count: number }
      if (count.count >= maxChallenges) throw new DomainError('RATE_LIMITED', 'Login temporarily unavailable')
      const value = token()
      const expiresAt = now() + 10 * 60 * 1000
      sql.prepare('INSERT INTO auth_login_challenges (token_hash, expires_at) VALUES (?, ?)').run(hash(value), expiresAt)
      challengesIssued++
      return { token: value, csrfToken: csrf(value), expiresAt }
    },
    async login(input: LoginInput) {
      try {
        const attempt = admitLogin(input)
        if (!validToken(input.challengeToken) || !matchesCsrf(input.challengeToken, input.csrfToken)) throw denied()
        if (activeVerifications >= maxVerifications) {
          attempt.count--
          throw new DomainError('BUSY', 'Login temporarily unavailable')
        }
        const challenge = sql.prepare('DELETE FROM auth_login_challenges WHERE token_hash = ? AND expires_at > ? RETURNING token_hash')
          .get(hash(input.challengeToken), now())
        if (!challenge) throw denied()
        activeVerifications++
        let correct: boolean
        try {
          correct = await verifyPassword(input.password, config.adminPasswordHash)
        } finally {
          activeVerifications--
        }
        if (!correct || input.username !== config.adminUsername) throw denied()
        attempt.count--
        const value = token()
        const session: Session = { id: randomUUID(), ownerId, expiresAt: now() + 12 * 60 * 60 * 1000, csrfToken: csrf(value) }
        sql.transaction(() => {
          sweepExpired()
          if (input.previousSessionToken) logout(input.previousSessionToken)
          const count = sql.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }
          if (count.count >= maxSessions) throw new DomainError('RATE_LIMITED', 'Login temporarily unavailable')
          sql.prepare('INSERT INTO auth_sessions (id, owner_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
            .run(session.id, ownerId, hash(value), session.expiresAt)
        })()
        audit({ event: 'login_succeeded', ownerId })
        return { token: value, session }
      } catch (error) {
        if (isDomainError(error) && (error.code === 'RATE_LIMITED' || error.code === 'BUSY')) {
          // Saturated callers can retry without bound; emit at most once per minute.
          if (now() >= rateLimitAuditedUntil) {
            rateLimitAuditedUntil = now() + 60_000
            audit({ event: 'login_rate_limited' })
          }
        } else {
          audit({ event: 'login_rejected' })
        }
        throw error
      }
    },
    getSession,
    requireSession,
    logout,
    sweepExpired,
    isLiveSession(id: string, principalOwnerId: string): boolean {
      return Boolean(sql.prepare('SELECT 1 FROM auth_sessions WHERE id = ? AND owner_id = ? AND expires_at > ?').get(id, principalOwnerId, now()))
    },
    verifySessionCsrf(value: string | null, supplied: string) {
      const session = requireSession(value)
      if (!value || !matchesCsrf(value, supplied)) throw denied()
      return session
    },
    createKey(principal: Principal, label: string): KeySummary & { key: string } {
      requireOwner(principal)
      const normalized = typeof label === 'string' ? label.trim() : ''
      if (!normalized || normalized.length > 100 || /\p{Cc}/u.test(normalized)) {
        throw new DomainError('INVALID_INPUT', 'Key label must contain 1 to 100 characters without control characters')
      }
      const key = `agp_${token()}`
      const summary = { id: randomUUID(), label: normalized, prefix: key.slice(0, 12), createdAt: new Date(now()).toISOString() }
      sql.transaction(() => {
        const count = sql.prepare('SELECT COUNT(*) AS count FROM auth_api_keys WHERE owner_id = ?').get(principal.ownerId) as { count: number }
        if (count.count >= 10) throw new DomainError('QUOTA_EXCEEDED', 'At most 10 active API keys are permitted')
        sql.prepare('INSERT INTO auth_api_keys (id, owner_id, token_hash, label, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(summary.id, principal.ownerId, hash(key), summary.label, summary.prefix, summary.createdAt)
      })()
      audit({ event: 'key_created', ownerId: principal.ownerId, keyId: summary.id })
      return { ...summary, key }
    },
    listKeys(principal: Principal): KeySummary[] {
      requireOwner(principal)
      return sql.prepare('SELECT id, label, prefix, created_at AS createdAt FROM auth_api_keys WHERE owner_id = ? ORDER BY created_at, id')
        .all(principal.ownerId) as KeySummary[]
    },
    revokeKey(principal: Principal, keyId: string) {
      requireOwner(principal)
      if (!sql.prepare('DELETE FROM auth_api_keys WHERE id = ? AND owner_id = ?').run(keyId, principal.ownerId).changes) {
        throw new DomainError('NOT_FOUND', 'Not found')
      }
      audit({ event: 'key_revoked', ownerId: principal.ownerId, keyId })
    },
    readBearer(request: Request): Principal {
      requireOrigin(request, config.appOrigin, false)
      const match = /^Bearer (agp_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') ?? '')
      if (!match) throw denied()
      const principal = sql.prepare('SELECT owner_id AS ownerId FROM auth_api_keys WHERE token_hash = ?').get(hash(match[1])) as Principal | undefined
      if (!principal) throw denied()
      return principal
    },
  }
}
