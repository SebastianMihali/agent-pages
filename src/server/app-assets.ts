import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { contentType, lookup } from 'mime-types'

/** Called only after the application authority has been accepted. */
export async function serveAppAsset(request: Request, publicRoot = resolve('.output/public')): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/assets/')) return null
  if (!/^\/assets\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|woff2?|svg|png|ico)$/.test(path)) {
    return new Response('Not found', { status: 404 })
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  try {
    const file = await open(resolve(publicRoot, path.slice(1)), 'r')
    let streaming = false
    try {
      const stat = await file.stat()
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
      const headers = {
        'content-type': contentType(lookup(path) || 'application/octet-stream') || 'application/octet-stream',
        'content-length': String(stat.size),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      }
      if (request.method === 'HEAD') return new Response(null, { headers })
      const response = new Response(Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>, { headers })
      streaming = true
      return response
    } finally { if (!streaming) await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response('Not found', { status: 404 })
    throw error
  }
}
