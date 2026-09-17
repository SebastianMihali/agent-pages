import { DomainError, type Principal } from './errors'
import type { SiteModule } from './sites'

export async function exportResponse(request: Request, sites: SiteModule, principal: Principal, siteId: string) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } })
  if (new URL(request.url).search) throw new DomainError('INVALID_INPUT', 'Query parameters are not accepted for exports')
  const archive = await sites.exportSite(principal, siteId, request.signal)
  return new Response(archive.body, { headers: {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="site-${siteId}.zip"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'x-agent-pages-revision': archive.revisionId,
  } })
}
