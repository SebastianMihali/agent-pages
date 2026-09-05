import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { createAuth } from './index'

const config = {
  appOrigin: 'https://app.example.com',
  adminUsername: 'owner',
  adminPasswordHash: 'scrypt$131072$8$1$01010101010101010101010101010101$8e42ace0fdaa6233ab07d1ace292170ded23f47cc4d1034fa021207f1e8467f8',
}

describe('owner authentication through persistent operations', () => {
  let dataDir: string
  let db: AppDatabase
  let now: number
  let auth: ReturnType<typeof createAuth>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-pages-auth-'))
    db = openDatabase(dataDir)
    now = Date.parse('2026-09-05T10:00:00Z')
    auth = createAuth(db, config, { now: () => now })
  })
  afterEach(() => {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const login = async () => {
    const challenge = auth.createLoginChallenge()
    return auth.login({ username: 'owner', password: 'correct test password',
      challengeToken: challenge.token, csrfToken: challenge.csrfToken, ip: '127.0.0.1' })
  }

  it('authenticates the provisioned owner and expires its session after twelve hours', async () => {
    const signedIn = await login()
    expect(auth.requireSession(signedIn.token).ownerId).toBe(auth.ownerId)
    expect(signedIn.session.expiresAt).toBe(Date.parse('2026-09-05T22:00:00Z'))
    expect(auth.verifySessionCsrf(signedIn.token, signedIn.session.csrfToken).id).toBe(signedIn.session.id)
    now += 12 * 60 * 60 * 1000
    expect(auth.getSession(signedIn.token)).toBeNull()
  })

  it('rotates sessions on login and revokes them on logout and restart without replacing the owner', async () => {
    const first = await login()
    const challenge = auth.createLoginChallenge()
    const second = await auth.login({ username: 'owner', password: 'correct test password',
      challengeToken: challenge.token, csrfToken: challenge.csrfToken, ip: '127.0.0.1', previousSessionToken: first.token })
    expect(auth.getSession(first.token)).toBeNull()
    expect(auth.isLiveSession(second.session.id, auth.ownerId)).toBe(true)
    expect(auth.isLiveSession(second.session.id, 'another-owner')).toBe(false)
    auth.logout(second.token)
    expect(auth.getSession(second.token)).toBeNull()
    const third = await login()
    const ownerId = auth.ownerId
    db.close()
    db = openDatabase(dataDir)
    auth = createAuth(db, { ...config, adminUsername: 'renamed-owner' }, { now: () => now })
    expect(auth.ownerId).toBe(ownerId)
    expect(auth.getSession(third.token)).toBeNull()
  })

  it('shows an owner key once, requires bearer credentials, and preserves it until immediate revocation', () => {
    const owner = { ownerId: auth.ownerId }
    const issued = auth.createKey(owner, 'Coding agent')
    const request = () => new Request('https://app.example.com/api/sites', { headers: { authorization: `Bearer ${issued.key}` } })
    expect(issued.key).toMatch(/^agp_[A-Za-z0-9_-]{43}$/)
    expect(auth.listKeys(owner)).toEqual([{ id: issued.id, label: 'Coding agent', prefix: issued.prefix, createdAt: issued.createdAt }])
    expect(auth.readBearer(request())).toEqual(owner)
    expect(() => auth.readBearer(new Request('https://app.example.com/api/sites', { headers: { cookie: `agp-session=${issued.key}` } })))
      .toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    expect(() => auth.readBearer(new Request(request(), { headers: { authorization: `Bearer ${issued.key}`, origin: 'https://attacker.sites.example.com' } })))
      .toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    db.close()
    db = openDatabase(dataDir)
    auth = createAuth(db, config, { now: () => now })
    expect(auth.readBearer(request())).toEqual(owner)
    auth.revokeKey(owner, issued.id)
    expect(() => auth.readBearer(request())).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    expect(auth.listKeys(owner)).toEqual([])
  })

  it('bounds active keys and rejects a synthetic other principal at owner-scoped operations', () => {
    const owner = { ownerId: auth.ownerId }
    const other = { ownerId: 'another-owner' }
    const first = auth.createKey(owner, 'First')
    expect(() => auth.createKey(other, 'Forged')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => auth.listKeys(other)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => auth.revokeKey(other, first.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    for (let index = 1; index < 10; index++) auth.createKey(owner, `Key ${index}`)
    expect(() => auth.createKey(owner, 'Excess')).toThrow(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }))
    auth.revokeKey(owner, first.id)
    expect(auth.createKey(owner, 'Replacement').label).toBe('Replacement')
    expect(() => auth.createKey(owner, '   ')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('throttles five failed logins per normalized account and IP then admits after the window', async () => {
    for (let index = 0; index < 5; index++) {
      const challenge = auth.createLoginChallenge()
      await expect(auth.login({ username: index % 2 ? ' OWNER ' : 'owner', password: 'incorrect',
        challengeToken: challenge.token, csrfToken: challenge.csrfToken, ip: '127.0.0.1' }))
        .rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Authentication failed' })
    }
    await expect(login()).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    now += 60_000
    expect((await login()).session.ownerId).toBe(auth.ownerId)
  })

  it('bounds native password verification concurrency and aggregate login attempts', async () => {
    auth = createAuth(db, config, { now: () => now, maxConcurrentVerifications: 1, maxLoginAttemptsPerMinute: 2 })
    const first = login()
    await expect(login()).rejects.toMatchObject({ code: 'BUSY' })
    await first
    await expect(login()).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    now += 60_000
    expect((await login()).session.ownerId).toBe(auth.ownerId)
  })

  it('bounds live login challenges and sessions and reclaims expired records', async () => {
    auth = createAuth(db, config, { now: () => now, maxLoginChallenges: 2, maxSessions: 2 })
    auth.createLoginChallenge()
    auth.createLoginChallenge()
    expect(() => auth.createLoginChallenge()).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }))
    now += 10 * 60_000
    const first = await login()
    await login()
    await expect(login()).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    auth.logout(first.token)
    expect((await login()).session.ownerId).toBe(auth.ownerId)
    now += 12 * 60 * 60_000
    auth.sweepExpired()
    expect((await login()).session.ownerId).toBe(auth.ownerId)
  })

  it('rejects forged CSRF, replayed and expired login challenges and another session’s CSRF', async () => {
    const challenge = auth.createLoginChallenge()
    const input = { username: 'owner', password: 'correct test password',
      challengeToken: challenge.token, csrfToken: challenge.csrfToken, ip: '127.0.0.1' }
    await expect(auth.login({ ...input, csrfToken: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const first = await auth.login(input)
    await expect(auth.login(input)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const second = await login()
    expect(() => auth.verifySessionCsrf(second.token, first.session.csrfToken)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    const expired = auth.createLoginChallenge()
    now += 10 * 60_000
    await expect(auth.login({ ...input, challengeToken: expired.token, csrfToken: expired.csrfToken }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(auth.getSession('malformed')).toBeNull()
  })

  it('never persists complete keys, session tokens, login challenges or passwords', async () => {
    const challenge = auth.createLoginChallenge()
    const signedIn = await login()
    const issued = auth.createKey({ ownerId: auth.ownerId }, 'Fixture')
    // Disk contents are intentionally inspected here: credential persistence is the trust boundary.
    const stored = Buffer.concat(['database.sqlite', 'database.sqlite-wal'].map((file) => readFileSync(join(dataDir, file))))
    for (const secret of [challenge.token, signedIn.token, issued.key, 'correct test password']) {
      expect(stored.includes(Buffer.from(secret))).toBe(false)
    }
    expect(JSON.stringify(auth.listKeys({ ownerId: auth.ownerId }))).not.toContain(issued.key)
  })

  it('reuses a live login challenge and rate-limits only newly issued challenges', async () => {
    auth = createAuth(db, config, { now: () => now, maxLoginAttemptsPerMinute: 2 })
    const first = auth.createLoginChallenge()
    for (let index = 0; index < 5; index++) expect(auth.createLoginChallenge(first.token)).toEqual(first)
    auth.createLoginChallenge()
    expect(() => auth.createLoginChallenge()).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }))
    expect(auth.createLoginChallenge(first.token)).toEqual(first)
    expect((await auth.login({ username: 'owner', password: 'correct test password',
      challengeToken: first.token, csrfToken: first.csrfToken, ip: '127.0.0.1' })).session.ownerId).toBe(auth.ownerId)
    now += 60_000
    expect(auth.createLoginChallenge().token).not.toBe(first.token)
  })
})
