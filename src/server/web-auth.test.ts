import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createAuth } from './auth'
import { hashPassword } from './auth/password'
import { openDatabase } from './db'
import { parseConfig } from './config'
import { createAuthWebHandler } from './web-auth'

it('logs the owner in and creates a key without accepting bearer auth as a web session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-web-auth-'))
  const db = openDatabase(directory)
  try {
    const config = parseConfig({ NODE_ENV: 'test', DATA_DIR: directory,
      APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
      ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: await hashPassword('test-only-password-123'),
    })
    const auth = createAuth(db, config)
    const handle = createAuthWebHandler(config, auth)
    const bootstrap = await handle(new Request(`${config.appOrigin}/web/session`))
    expect(bootstrap?.status).toBe(200)
    const challenge = await bootstrap!.json()
    const cookie = bootstrap!.headers.get('set-cookie')!.split(';')[0]
    const login = await handle(new Request(`${config.appOrigin}/web/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: config.appOrigin, cookie },
      body: JSON.stringify({ username: 'owner', password: 'test-only-password-123', csrfToken: challenge.csrfToken }),
    }))
    expect(login?.status).toBe(200)
    const signedIn = await login!.json()
    const sessionCookie = login!.headers.getSetCookie().find((value) => value.startsWith('__Host-agp-session='))!.split(';')[0]
    const created = await handle(new Request(`${config.appOrigin}/web/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: config.appOrigin, cookie: sessionCookie },
      body: JSON.stringify({ label: 'Codex', csrfToken: signedIn.csrfToken }),
    }))
    expect(created?.status).toBe(201)
    const key = await created!.json()
    const denied = await handle(new Request(`${config.appOrigin}/web/keys`, { headers: { authorization: `Bearer ${key.key}` } }))
    expect(denied?.status).toBe(401)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

it('reuses a browser’s login challenge while limiting anonymous challenge issuance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agp-web-challenge-'))
  const db = openDatabase(directory)
  try {
    const config = parseConfig({ NODE_ENV: 'test', DATA_DIR: directory, APP_ORIGIN: 'https://app.example.com',
      CONTENT_BASE_DOMAIN: 'sites.example.com', ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}` })
    const auth = createAuth(db, config, { maxLoginAttemptsPerMinute: 2 })
    const handle = createAuthWebHandler(config, auth)
    const first = await handle(new Request(`${config.appOrigin}/web/session`))
    const challenge = await first!.json()
    const cookie = first!.headers.get('set-cookie')!.split(';')[0]
    for (let index = 0; index < 3; index++) {
      const reused = await handle(new Request(`${config.appOrigin}/web/session`, { headers: { cookie } }))
      expect(reused!.status).toBe(200)
      expect(await reused!.json()).toEqual(challenge)
      expect(reused!.headers.get('set-cookie')!.split(';')[0]).toBe(cookie)
    }
    expect((await handle(new Request(`${config.appOrigin}/web/session`)))!.status).toBe(200)
    expect((await handle(new Request(`${config.appOrigin}/web/session`)))!.status).toBe(429)
    expect((await handle(new Request(`${config.appOrigin}/web/session`, { headers: { cookie } })))!.status).toBe(200)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
