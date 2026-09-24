import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { AppConfig } from './config'
import type { SiteModule } from './sites'
import type { Access } from './access'
import { localReturnPath } from './access'
import { readBody, readJson } from './body'
import { DomainError, errorResponse, requireOrigin } from './errors'
import { exportResponse } from './site-export'
import { siteOrigin } from './hosts'
import { siteInputSchemas } from './site-input'
import { cookieNames, json, parseInput, readCookie, type Auth } from './web-auth'
import { allowedDefaultExpiresInSeconds } from './sites/expiration'
import { editorByteLimit, readWebFile } from './web-file'
import { fileLanguage } from '../shared/site-file'
import { readMultipart } from './multipart'

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
  const deletion = schemas.delete.extend({ csrfToken: z.string().max(128) })
  const fileDeletion = schemas.deleteFiles.extend({ csrfToken: z.string().max(128) })
  const visibility = schemas.visibility.extend({ csrfToken: z.string().max(128) })
  const expiration = schemas.expiration.extend({ csrfToken: z.string().max(128) })
  const restore = schemas.restore.extend({ csrfToken: z.string().max(128) })
  const fileRead = schemas.read.extend({ mode: z.enum(['download', 'preview']).optional() })
    .refine((input) => !input.revisionId || input.mode !== undefined)
  const fileWrite = schemas.delete.extend({ csrfToken: z.string().max(128), path: z.string().min(1).max(512), content: z.string() })
  const settings = z.strictObject({ csrfToken: z.string().max(128),
    defaultExpiresInSeconds: z.number().int().refine((value) => allowedDefaultExpiresInSeconds.has(value)).nullable() })
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const web = /^\/web\/sites(?:\/([a-f0-9]{32})(?:\/(file|files|files\/delete|visibility|expiration|export|revisions|restore))?)?$/.exec(url.pathname)
    const overview = url.pathname === '/web/overview'
    const ownerSettings = url.pathname === '/web/settings'
    const opening = /^\/sites\/([a-f0-9]{32})\/open$/.exec(url.pathname)
    if (!web && !opening && !ownerSettings && !overview) return null
    try {
      const sessionToken = readCookie(request, cookieNames(config).session)
      if (overview || web?.[2] === 'file' || web?.[2] === 'revisions' || web?.[2] === 'restore') {
        requireOrigin(request, config.appOrigin, request.method !== 'GET')
        const fetchSite = request.headers.get('sec-fetch-site')
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new DomainError('UNAUTHENTICATED', 'Request origin is not permitted')
        if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new DomainError('INVALID_INPUT', 'Duplicate query parameters')
        if (url.searchParams.has('siteId')) throw new DomainError('INVALID_INPUT', 'Site identity belongs in the route path')
      }
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
      if (web?.[2] === 'export') {
        requireOrigin(request, config.appOrigin, false)
        const fetchSite = request.headers.get('sec-fetch-site')
        if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
          throw new DomainError('UNAUTHENTICATED', 'Request origin is not permitted')
        }
        return await exportResponse(request, sites, auth.requireSession(sessionToken), web[1])
      }
      if (request.method !== 'GET') requireOrigin(request, config.appOrigin)
      const session = auth.requireSession(sessionToken)
      const creating = Boolean(web && !web[1] && request.method === 'POST')
      const writing = web?.[2] === 'files' && request.method === 'PUT'
      const deletingFiles = web?.[2] === 'files/delete'
      const restoring = web?.[2] === 'restore'
      if (creating || writing || deletingFiles || restoring) {
        if (request.headers.has('authorization')) throw new DomainError('UNAUTHENTICATED', 'An owner session is required')
        const fetchSite = request.headers.get('sec-fetch-site')
        if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new DomainError('UNAUTHENTICATED', 'Request origin is not permitted')
        if (url.search) throw new DomainError('INVALID_INPUT', 'Query parameters are not accepted for publication')
      }
      if (creating || writing) {
        // The multipart parser must never read untrusted bytes before session CSRF validation.
        auth.verifySessionCsrf(sessionToken, request.headers.get('x-csrf-token') ?? '')
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') {
          throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Browser publication requires multipart/form-data')
        }
        if (creating) {
          const upload = await readMultipart(request, config, { fields: schemas.create.omit({ files: true }), deadlineMs: 120_000 })
          try {
            return json(await sites.createSite(session, { ...upload.manifest, files: upload.files, maximumUploadBytes: upload.maximumUploadBytes }), 201)
          } finally { await upload.close() }
        }
        const upload = await readMultipart(request, config, { fields: schemas.delete, deadlineMs: 120_000 })
        try {
          return json(await sites.writeFiles(session, { ...upload.manifest, siteId: web![1], files: upload.files, maximumUploadBytes: upload.maximumUploadBytes }))
        } finally { await upload.close() }
      }
      if (deletingFiles) {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        const input = parseInput(fileDeletion, await readJson(request, config.limits.maxJsonBodyBytes))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        return json(await sites.deleteFiles(session, { siteId: web![1], operationId: input.operationId,
          expectedVersion: input.expectedVersion, paths: input.paths }))
      }
      if (restoring) {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
        const input = parseInput(restore, await readJson(request, config.limits.maxJsonBodyBytes))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        return json(await sites.restoreRevision(session, { siteId: web![1], revisionId: input.revisionId,
          operationId: input.operationId, expectedVersion: input.expectedVersion }))
      }
      if (overview) {
        if (url.search) throw new DomainError('INVALID_INPUT', 'Overview accepts no query parameters')
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
        return json(await sites.getOverview(session))
      }
      if (ownerSettings) {
        if (request.method === 'GET') {
          const { maxFileBytes, maxBatchFiles, maxMultipartBodyBytes, maxFilesPerSite, maxSiteBytes } = config.limits
          return json({ ...await sites.getOwnerSettings(session), limits: { maxFileBytes, maxBatchFiles, maxMultipartBodyBytes, maxFilesPerSite, maxSiteBytes } })
        }
        if (request.method === 'POST') {
          const input = parseInput(settings, await readJson(request, 4096))
          auth.verifySessionCsrf(sessionToken, input.csrfToken)
          return json(await sites.setOwnerSettings(session, { defaultExpiresInSeconds: input.defaultExpiresInSeconds }))
        }
        return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
      }
      const [, siteId, action] = web!
      if (action === 'revisions') {
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
        return json(await sites.listRevisions(session, parseInput(schemas.revisions, { ...Object.fromEntries(url.searchParams), siteId })))
      }
      if (action === 'file') {
        if (request.method === 'GET') return await readWebFile(sites, session, config,
          parseInput(fileRead, { ...Object.fromEntries(url.searchParams), siteId }))
        if (request.method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
        if (url.search) throw new DomainError('INVALID_INPUT', 'File writes accept no query parameters')
        const input = parseInput(fileWrite, await readJson(request, config.limits.maxJsonBodyBytes))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        if (!fileLanguage(input.path)) throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Only supported text files can be edited')
        if (Buffer.byteLength(input.content) > editorByteLimit(config)) throw new DomainError('PAYLOAD_TOO_LARGE', 'File exceeds the editor limit')
        return json(await sites.editFile(session, { siteId, operationId: input.operationId, expectedVersion: input.expectedVersion,
          path: input.path, content: input.content }))
      }
      if (request.method === 'GET' && action !== 'visibility' && action !== 'expiration') {
        const query: Record<string, unknown> = Object.fromEntries(url.searchParams)
        if (query.limit !== undefined) query.limit = Number(query.limit)
        if (!siteId) return json(await sites.listSites(session, parseInput(schemas.list, query)))
        if (action === 'files') return json(await sites.listFiles(session, parseInput(schemas.listFiles, { ...query, siteId })))
        return json(await sites.getSite(session, siteId))
      }
      if (request.method === 'DELETE' && siteId && !action) {
        if (url.search) throw new DomainError('INVALID_INPUT', 'Query parameters are not accepted for deletion')
        const input = parseInput(deletion, await readJson(request, 4096))
        auth.verifySessionCsrf(sessionToken, input.csrfToken)
        return json(await sites.deleteSite(session, { siteId, operationId: input.operationId, expectedVersion: input.expectedVersion }))
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
