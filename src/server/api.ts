import type { createAuth } from './auth'
import { readJson } from './body'
import type { AppConfig } from './config'
import { DomainError, errorResponse } from './errors'
import { readMultipart } from './multipart'
import { parseSiteInput, siteInputSchemas } from './site-input'
import type { SiteModule } from './sites'

const responseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: responseHeaders })

function queryInput(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) throw new DomainError('INVALID_INPUT', 'Duplicate query parameters are not permitted')
    Object.defineProperty(result, key, { value: key === 'limit' && /^\d+$/.test(value) ? Number(value) : value, enumerable: true })
  }
  return result
}

export function createApiHandler(config: AppConfig, auth: ReturnType<typeof createAuth>, sites: SiteModule) {
  const schemas = siteInputSchemas(config)
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null
    try {
      const principal = auth.readBearer(request)
      const match = /^\/api\/sites(?:\/([a-f0-9]{32})(?:\/(file|files|files\/delete|visibility))?)?$/.exec(url.pathname)
      if (!match) throw new DomainError('NOT_FOUND', 'Not found')
      const [, siteId, resource] = match
      const query = queryInput(url)
      if (Object.hasOwn(query, 'siteId')) throw new DomainError('INVALID_INPUT', 'Site identity belongs in the route path')
      if (request.method !== 'GET' && request.method !== 'HEAD' && url.search) {
        throw new DomainError('INVALID_INPUT', 'Query parameters are not accepted for mutations')
      }
      if (!siteId && request.method === 'POST') {
        if (url.search) throw new DomainError('INVALID_INPUT', 'Query parameters are not accepted for mutations')
        return json(await sites.createSite(principal, parseSiteInput(schemas.create, await readJson(request, config.limits.maxJsonBodyBytes))), 201)
      }
      if (!siteId && request.method === 'GET') return json(await sites.listSites(principal, parseSiteInput(schemas.list, query)))
      if (siteId && !resource && request.method === 'GET') {
        parseSiteInput(schemas.get, { ...query, siteId })
        return json(await sites.getSite(principal, siteId))
      }
      if (siteId && resource === 'file' && request.method === 'GET') {
        const file = await sites.openOwnedFile(principal, parseSiteInput(schemas.read, { ...query, siteId }))
        return new Response(file.body, { headers: { ...responseHeaders, 'content-type': file.contentType, 'content-length': String(file.sizeBytes),
          'x-agent-pages-revision': file.revisionId, 'x-agent-pages-digest': file.digest } })
      }
      if (siteId && resource === 'files' && request.method === 'GET') {
        return json(await sites.listFiles(principal, parseSiteInput(schemas.listFiles, { ...query, siteId })))
      }
      if (siteId && resource === 'files' && request.method === 'PUT') {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'multipart/form-data') {
          const upload = await readMultipart(request, config)
          try {
            return json(await sites.writeFiles(principal, { siteId, operationId: upload.operationId,
              expectedVersion: upload.expectedVersion, files: upload.files, maximumUploadBytes: upload.maximumUploadBytes }))
          } finally { await upload.close() }
        }
        return json(await sites.writeFiles(principal, { ...parseSiteInput(schemas.write, await readJson(request, config.limits.maxJsonBodyBytes)), siteId }))
      }
      if (siteId && resource === 'files/delete' && request.method === 'POST') {
        return json(await sites.deleteFiles(principal, { ...parseSiteInput(schemas.deleteFiles, await readJson(request, config.limits.maxJsonBodyBytes)), siteId }))
      }
      if (siteId && resource === 'visibility' && request.method === 'PUT') {
        return json(await sites.setVisibility(principal, { ...parseSiteInput(schemas.visibility, await readJson(request, config.limits.maxJsonBodyBytes)), siteId }))
      }
      if (siteId && !resource && request.method === 'DELETE') {
        return json(await sites.deleteSite(principal, { ...parseSiteInput(schemas.delete, await readJson(request, config.limits.maxJsonBodyBytes)), siteId }))
      }
      const allow = !siteId ? 'GET, POST' : !resource ? 'GET, DELETE' : resource === 'files' ? 'GET, PUT' : resource === 'files/delete' ? 'POST' : resource === 'visibility' ? 'PUT' : 'GET'
      return new Response(null, { status: 405, headers: { ...responseHeaders, allow } })
    } catch (error) { return errorResponse(error) }
  }
}
