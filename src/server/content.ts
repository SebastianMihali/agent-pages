import type { AppConfig } from './config'
import type { SiteModule, RevisionLease } from './sites'
import type { Access } from './access'
import { localReturnPath } from './access'
import { readBody } from './body'
import { DomainError, logFailure, requireOrigin } from './errors'
import { cookie, cookieNames, readCookie } from './web-auth'

const securityHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), document-domain=()',
  'origin-agent-cluster': '?1',
  'content-security-policy': "default-src 'self' https: http: data: blob:; script-src 'self' https: http: 'unsafe-inline'; style-src 'self' https: http: 'unsafe-inline'; worker-src 'none'; frame-ancestors 'none'",
}
const missing = (head = false) => new Response(head ? null : 'Not found', { status: 404, headers: securityHeaders })

const invalidPath = () => new DomainError('INVALID_PATH', 'Invalid path')
function contentPath(pathname: string) {
  if (/%2f|%5c/i.test(pathname)) throw invalidPath()
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { throw invalidPath() }
  if (Buffer.byteLength(decoded) > 513 || /[\\%\p{Cc}]/u.test(decoded)) throw invalidPath()
  const parts = decoded.slice(1).split('/')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length > 32 || parts.some((part) => !part || part.startsWith('.')) || parts[0] === '_agent') throw invalidPath()
  return parts.join('/') + (decoded.endsWith('/') && parts.length ? '/' : '')
}
function formFields(bytes: Uint8Array) {
  try { return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new DomainError('INVALID_INPUT', 'Form body must be UTF-8') }
}

export function createContentHandler(config: AppConfig, sites: SiteModule, access: Access) {
  const names = cookieNames(config)
  return async (request: Request, siteId: string): Promise<Response> => {
    const url = new URL(request.url)
    let lease: RevisionLease | undefined
    let transferred = false
    try {
      if (url.pathname === '/_agent/session') {
        if (request.method !== 'POST') return missing()
        requireOrigin(request, config.appOrigin)
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return missing()
        const body = formFields(await readBody(request, 4096))
        if ([...body.keys()].length !== 1 || !body.has('ticket')) return missing()
        const grant = await access.redeem(body.get('ticket')!, siteId)
        return new Response(null, { status: 303, headers: { ...securityHeaders,
          location: grant.returnPath, 'set-cookie': cookie(config, names.site, grant.token, (grant.expiresAt - Date.now()) / 1000),
        } })
      }
      if (url.pathname.startsWith('/_agent') || request.headers.get('service-worker')?.toLowerCase() === 'script') return missing(request.method === 'HEAD')
      if (!['GET', 'HEAD'].includes(request.method)) return missing()
      lease = await sites.acquireActiveRevision(siteId)
      if (!access.permits(readCookie(request, names.site), lease.site)) {
        if (request.method === 'GET' && request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-dest') === 'document') {
          const destination = new URL(`/sites/${siteId}/open`, config.appOrigin)
          destination.searchParams.set('returnPath', localReturnPath(url.pathname + url.search))
          return new Response(null, { status: 303, headers: { ...securityHeaders, location: destination.href } })
        }
        return missing(request.method === 'HEAD')
      }
      const path = contentPath(url.pathname)
      const files = new Map(lease.manifest.map((entry) => [entry.path, entry]))
      let target = path === '' ? 'index.html' : path.endsWith('/') ? `${path}index.html` : path
      let status = 200
      if (!files.has(target) && path && !path.endsWith('/')) {
        if (files.has(`${path}.html`)) target = `${path}.html`
        else if (files.has(`${path}/index.html`)) return new Response(null, {
          status: 308, headers: { ...securityHeaders, location: url.pathname + '/' + url.search },
        })
      }
      if (!files.has(target)) { target = '404.html'; status = 404 }
      const entry = files.get(target)
      if (!entry) return missing(request.method === 'HEAD')
      // Opening rechecks the current lifecycle/generation before acquiring the descriptor.
      const file = await lease.open(target)
      transferred = true
      if (request.method === 'HEAD') await file.body.cancel()
      return new Response(request.method === 'HEAD' ? null : file.body, { status, headers: {
        ...securityHeaders, 'content-type': entry.contentType, 'content-length': String(entry.sizeBytes),
      } })
    } catch (error) {
      // Visitors always receive 404; only storage and foreign failures are logged.
      logFailure('content_request_failed', error, { siteId })
      return missing(request.method === 'HEAD')
    } finally { if (!transferred) await lease?.release() }
  }
}
