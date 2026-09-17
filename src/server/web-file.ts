import type { AppConfig } from './config'
import type { Principal } from './errors'
import { DomainError } from './errors'
import type { SiteFileView, SiteModule } from './sites'
import { fileLanguage, isRasterImage, maxEditorBytes } from '../shared/site-file'
import { json } from './web-auth'

export function editorByteLimit(config: AppConfig) {
  // JSON can escape each byte into six characters. Leave room for the envelope.
  return Math.max(0, Math.min(maxEditorBytes, config.limits.maxFileBytes, Math.floor((config.limits.maxJsonBodyBytes - 4096) / 6)))
}

export async function readWebFile(sites: SiteModule, principal: Principal, config: AppConfig,
  query: { siteId: string; path: string; mode?: 'download' | 'preview' }) {
  const { site, file: opened } = await sites.openCurrentFile(principal, query)
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    'content-length': String(opened.sizeBytes),
  }
  if (query.mode === 'download') {
    const name = query.path.split('/').at(-1)!
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return new Response(opened.body, { headers: { ...headers, 'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="file"; filename*=UTF-8''${encoded}` } })
  }
  if (query.mode === 'preview') {
    if (!isRasterImage(query.path)) {
      await opened.body.cancel()
      throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Only raster images can be previewed here')
    }
    return new Response(opened.body, { headers: { ...headers, 'content-type': opened.contentType } })
  }
  const limit = editorByteLimit(config)
  const file = { path: opened.path, digest: opened.digest, sizeBytes: opened.sizeBytes, contentType: opened.contentType }
  let content: string | null = null
  let unavailableReason: string | null = null
  if (!fileLanguage(query.path)) unavailableReason = 'This binary file can be downloaded, but cannot be edited as text.'
  else if (opened.sizeBytes > limit) unavailableReason = `This file exceeds the ${Math.floor(limit / 1024)} KB editor limit. Download it to edit locally.`
  if (unavailableReason) await opened.body.cancel()
  else {
    const bytes = await new Response(opened.body).arrayBuffer()
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { unavailableReason = 'This file is not valid UTF-8. Download it to preserve its original encoding.' }
  }
  return json({ site, file, content, unavailableReason, maxEditableBytes: limit } satisfies SiteFileView)
}
