import { createHash, randomBytes } from 'node:crypto'
import type { Session } from './auth'
import type { Auth } from './web-auth'
import type { AppDatabase } from './db'
import type { RevisionLease, SiteModule } from './sites'
import { DomainError } from './errors'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const valid = (value: string | null): value is string => value !== null && /^[A-Za-z0-9_-]{43}$/.test(value)
const denied = () => new DomainError('NOT_FOUND', 'Not found')
type Site = RevisionLease['site']
type Binding = { owner_id: string; site_id: string; session_id: string; generation: number; expires_at: number }

export function localReturnPath(value: string): string {
  if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\p{Cc}#]/u.test(value) || /%2f|%5c|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(value)) throw denied()
  const parsed = new URL(value, 'https://content.invalid')
  if (parsed.origin !== 'https://content.invalid' || parsed.pathname.startsWith('/_agent')) throw denied()
  return parsed.pathname + parsed.search
}

export function createAccess(db: AppDatabase, auth: Auth, sites: SiteModule, now: () => number = Date.now) {
  const { sql } = db
  sql.exec(`
    CREATE TABLE IF NOT EXISTS site_tickets (
      token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, site_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, return_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_grants (
      token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, site_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS site_tickets_session ON site_tickets(session_id);
    CREATE INDEX IF NOT EXISTS site_grants_session ON site_grants(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS site_grants_session_site ON site_grants(session_id, site_id);
  `)
  function sweepExpired() {
    sql.prepare('DELETE FROM site_tickets WHERE expires_at <= ?').run(now())
    sql.prepare('DELETE FROM site_grants WHERE expires_at <= ?').run(now())
  }
  function matches(binding: Binding | undefined, site: Site) {
    return !!binding && binding.site_id === site.id && binding.owner_id === site.ownerId &&
      binding.generation === site.visibilityGeneration && binding.expires_at > now() &&
      (!site.expiresAt || site.expiresAt.getTime() > now()) && auth.isLiveSession(binding.session_id, binding.owner_id)
  }
  return {
    sweepExpired,
    async issue(session: Session, siteId: string, returnPath: string) {
      const destination = localReturnPath(returnPath)
      const lease = await sites.acquireActiveRevision(siteId)
      try {
        if (lease.site.ownerId !== session.ownerId || !auth.isLiveSession(session.id, session.ownerId)) throw denied()
        sweepExpired()
        const count = sql.prepare('SELECT COUNT(*) AS count FROM site_tickets WHERE session_id = ?').get(session.id) as { count: number }
        if (count.count >= 20) throw new DomainError('RATE_LIMITED', 'Too many outstanding site openings')
        const value = token()
        sql.prepare('INSERT INTO site_tickets VALUES (?, ?, ?, ?, ?, ?, ?)').run(hash(value), session.ownerId, siteId,
          session.id, lease.site.visibilityGeneration, Math.min(now() + 60_000, session.expiresAt), destination)
        return value
      } finally { await lease.release() }
    },
    async redeem(value: string, siteId: string) {
      if (!valid(value)) throw denied()
      const lease = await sites.acquireActiveRevision(siteId)
      try {
        return sql.transaction(() => {
          const binding = sql.prepare('SELECT * FROM site_tickets WHERE token_hash = ?').get(hash(value)) as (Binding & { return_path: string }) | undefined
          if (!matches(binding, lease.site) || !binding) throw denied()
          sweepExpired()
          // A browser has one cookie per site. Reopening replaces its grant,
          // revoking the overwritten token instead of exhausting the session cap.
          sql.prepare('DELETE FROM site_grants WHERE session_id = ? AND site_id = ?').run(binding.session_id, siteId)
          const count = sql.prepare('SELECT COUNT(*) AS count FROM site_grants WHERE session_id = ?').get(binding.session_id) as { count: number }
          if (count.count >= 100) throw new DomainError('RATE_LIMITED', 'Too many open site grants')
          const parent = sql.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').get(binding.session_id) as { expires_at: number }
          const grant = token()
          sql.prepare('DELETE FROM site_tickets WHERE token_hash = ?').run(hash(value))
          sql.prepare('INSERT INTO site_grants VALUES (?, ?, ?, ?, ?, ?)').run(hash(grant), binding.owner_id, siteId,
            binding.session_id, binding.generation, parent.expires_at)
          return { token: grant, returnPath: binding.return_path, expiresAt: parent.expires_at }
        })()
      } finally { await lease.release() }
    },
    permits(value: string | null, site: Site) {
      if (site.expiresAt && site.expiresAt.getTime() <= now()) return false
      if (site.visibility === 'public') return true
      if (!valid(value)) return false
      return matches(sql.prepare('SELECT * FROM site_grants WHERE token_hash = ?').get(hash(value)) as Binding | undefined, site)
    },
  }
}
export type Access = ReturnType<typeof createAccess>
