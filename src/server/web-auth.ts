import { z } from 'zod'
import type { createAuth } from './auth'
import type { AppConfig } from './config'
import { readJson } from './body'
import { DomainError, errorResponse, requireOrigin } from './errors'

export type Auth = ReturnType<typeof createAuth>

export function cookieNames(config: AppConfig) {
  const prefix = config.secureCookies ? '__Host-agp-' : 'agp-dev-'
  return { session: `${prefix}session`, challenge: `${prefix}login`, site: `${prefix}site` }
}

export function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null
}

export function cookie(config: AppConfig, name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${config.secureCookies ? '; Secure' : ''}`
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers)
  result.set('cache-control', 'no-store')
  result.set('x-content-type-options', 'nosniff')
  result.set('cross-origin-resource-policy', 'same-origin')
  return Response.json(data, { status, headers: result })
}

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Request fields are invalid', {
    fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
  })
  return parsed.data
}

const csrfField = z.string().max(128)
const loginSchema = z.object({ username: z.string().max(100), password: z.string().min(1).max(1024), csrfToken: csrfField }).strict()
const csrfSchema = z.object({ csrfToken: csrfField }).strict()
const keySchema = z.object({ csrfToken: csrfField, label: z.string().trim().min(1).max(100) }).strict()

export function createAuthWebHandler(config: AppConfig, auth: Auth) {
  const names = cookieNames(config)
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname
    const revoke = /^\/web\/keys\/([a-f0-9-]{36})\/revoke$/.exec(path)
    if (!['/web/session', '/web/login', '/web/logout', '/web/keys'].includes(path) && !revoke) return null
    try {
      const sessionToken = readCookie(request, names.session)
      if (path === '/web/session' && request.method === 'GET') {
        const session = auth.getSession(sessionToken)
        if (session) return json({ authenticated: true, username: config.adminUsername, csrfToken: session.csrfToken })
        const challenge = auth.createLoginChallenge(readCookie(request, names.challenge))
        return json({ authenticated: false, csrfToken: challenge.csrfToken }, 200, {
          'set-cookie': cookie(config, names.challenge, challenge.token, 600),
        })
      }
      if (path === '/web/keys' && request.method === 'GET') {
        return json({ keys: auth.listKeys(auth.requireSession(sessionToken)) })
      }
      if (request.method !== 'POST' || path === '/web/session') return new Response(null, { status: 405 })
      requireOrigin(request, config.appOrigin)
      if (path === '/web/login') {
        const input = parseInput(loginSchema, await readJson(request, 16 * 1024))
        const result = await auth.login({ ...input,
          challengeToken: readCookie(request, names.challenge) ?? '',
          // Per-account and installation limits apply without trusting a supplied IP header.
          ip: 'installation', previousSessionToken: sessionToken ?? undefined,
        })
        const headers = new Headers()
        headers.append('set-cookie', cookie(config, names.session, result.token, 12 * 60 * 60))
        headers.append('set-cookie', cookie(config, names.challenge, '', 0))
        return json({ authenticated: true, username: config.adminUsername, csrfToken: result.session.csrfToken }, 200, headers)
      }
      auth.requireSession(sessionToken)
      const input = await readJson(request, 16 * 1024)
      if (path === '/web/keys') {
        const command = parseInput(keySchema, input)
        const session = auth.verifySessionCsrf(sessionToken, command.csrfToken)
        return json(auth.createKey(session, command.label), 201)
      }
      const command = parseInput(csrfSchema, input)
      const session = auth.verifySessionCsrf(sessionToken, command.csrfToken)
      if (revoke) { auth.revokeKey(session, revoke[1]); return json({ revoked: true }) }
      auth.logout(sessionToken)
      return json({ authenticated: false }, 200, { 'set-cookie': cookie(config, names.session, '', 0) })
    } catch (error) { return errorResponse(error) }
  }
}
