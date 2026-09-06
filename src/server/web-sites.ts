import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { AppConfig } from './config'
import type { SiteModule } from './sites'
import type { Access } from './access'
import { localReturnPath } from './access'
import { readBody, readJson } from './body'
import { errorResponse, requireOrigin } from './errors'
import { siteOrigin } from './hosts'
import { siteInputSchemas } from './site-input'
import { cookieNames, json, parseInput, readCookie, type Auth } from './web-auth'
import { allowedDefaultExpiresInSeconds } from './sites/expiration'

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
function postForm(action: string, fields: Record<string, string>) {
  const nonce = randomBytes(24).toString('base64')
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open site · Agent Pages</title><body><p>Opening the private site…</p><form method="post" action="${escape(action)}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('')}<button type="submit">Open site</button></form><script nonce="${nonce}">document.forms[0].submit()</script></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    // Form navigations need a non-null Origin for the exact-origin CSRF check.
    // Only the origin is disclosed; tickets stay exclusively in the POST body.
    'referrer-policy': 'origin', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${action}; base-uri 'none'; frame-ancestors 'none'`,
  } })
}

export function createSitesWebHandler(config: AppConfig, auth: Auth, sites: SiteModule, access: Access) {
  const schemas = siteInputSchemas(config)
  const visibility = schemas.visibility.extend({ csrfToken: z.string().max(128) })
  const expiration = schemas.expiration.extend({ csrfToken: z.string().max(128) })
  const settings = z.strictObject({ csrfToken: z.string().max(128),
    defaultExpiresInSeconds: z.number().int().refine((value) => allowedDefaultExpiresInSeconds.has(value)).nullable() })
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const web = /^\/web\/sites(?:\/([a-f0-9]{32})(?:\/(files|visibility|expiration))?)?$/.exec(url.pathname)
    const ownerSettings = url.pathname === '/web/settings'
    const opening = /^\/sites\/([a-f0-9]{32})\/open$/.exec(url.pathname)
    if (!web && !opening && !ownerSettings) return null
    try {
      const sessionToken = readCookie(request, cookieNames(config).session)
      if (opening) {
        if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 })
        if (request.method === 'POST') requireOrigin(request, config.appOrigin)
        const session = auth.getSession(sessionToken)
        if (!session && request.method === 'GET') {
          const query = new URLSearchParams({ site: opening[1], returnPath: localReturnPath(url.searchParams.get('returnPath') ?? '/') })
          return new Response(null, { status: 303, headers: { location: `${config.appOrigin}/?${query}`, 'cache-control': 'no-store' } })
        }
        auth.requireSession(sessionToken)
        await sites.getSite(session!, opening[1])
        if (request.method === 'GET') return postForm(`${config.appOrigin}${url.pathname}`, {
          csrfToken: session!.csrfToken, returnPath: localReturnPath(url.searchParams.get('returnPath') ?? '/'),
        })
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response(null, { status: 415 })
        const body = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(request, 4096)))
        const fields = parseInput(z.object({ csrfToken: z.string().max(128), returnPath: z.string().max(2048) }).strict(), Object.fromEntries(body))
        if ([...body.keys()].length !== 2) return new Response(null, { status: 400 })
        auth.verifySessionCsrf(sessionToken, fields.csrfToken)
        const ticket = await access.issue(session!, opening[1], fields.returnPath)
        return postForm(`${siteOrigin(config, opening[1])}/_agent/session`, { ticket })
      }
      if (request.method !== 'GET') requireOrigin(request, config.appOrigin)
      const session = auth.requireSession(sessionToken)
      if (ownerSettings) {
        if (request.method === 'GET') return json(await sites.getOwnerSettings(session))
        if (request.method === 'POST') {
          const input = parseInput(settings, await readJson(request, 4096))
          auth.verifySessionCsrf(sessionToken, input.csrfToken)
          return json(await sites.setOwnerSettings(session, { defaultExpiresInSeconds: input.defaultExpiresInSeconds }))
        }
        return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
      }
      const [, siteId, action] = web!
      if (request.method === 'GET' && action !== 'visibility' && action !== 'expiration') {
        const query: Record<string, unknown> = Object.fromEntries(url.searchParams)
        if (query.limit !== undefined) query.limit = Number(query.limit)
        if (!siteId) return json(await sites.listSites(session, parseInput(schemas.list, query)))
        if (action === 'files') return json(await sites.listFiles(session, parseInput(schemas.listFiles, { ...query, siteId })))
        return json(await sites.getSite(session, siteId))
      }
      if (request.method === 'POST' && action === 'visibility') {
        const input = parseInput(visibility, await readJson(request, 4096))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        return json(await sites.setVisibility(session, { operationId: input.operationId,
          expectedVersion: input.expectedVersion, visibility: input.visibility, siteId }))
      }
      if (request.method === 'POST' && action === 'expiration') {
        const input = parseInput(expiration, await readJson(request, 4096))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        return json(await sites.setExpiration(session, { operationId: input.operationId,
          expectedVersion: input.expectedVersion, expiresInSeconds: input.expiresInSeconds, siteId }))
      }
      return new Response(null, { status: 405 })
    } catch (error) { return errorResponse(error) }
  }
}
