import type { ManifestEntry, OwnerSettings, RevisionHistory, RevisionView, SiteView } from '../../server/sites'
import type { PublicationLimits } from './publication-plan'

export type { OwnerSettings }
export type BrowserSettings = OwnerSettings & { limits: PublicationLimits }

export type Session =
  | { authenticated: false; csrfToken: string }
  | { authenticated: true; csrfToken: string; username: string }

export type SiteListResponse = {
  sites: SiteView[]
  cursor: string | null
}

export type FileListResponse = {
  revisionId: string
  files: ManifestEntry[]
  cursor: string | null
}

export type RevisionSummary = RevisionView
export type RevisionListResponse = RevisionHistory

export type ApiKeySummary = {
  id: string
  label: string
  prefix: string
  createdAt: string
}

export type CreatedApiKey = ApiKeySummary & { key: string }

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    let message = 'The request failed. Try again.'
    let code: string | undefined
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: { code?: string; message?: string } }
        if (body.error?.message) message = body.error.message
        if (body.error?.code) code = body.error.code
      } catch {
        // Keep the safe fallback for malformed upstream responses.
      }
    }
    throw new ApiFailure(message, response.status, code)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export function publicationBody(options: {
  manifest: Record<string, unknown>
  files: { path: string; file: File }[]
}): Blob {
  // Blob keeps file data outside JS memory and exposes the exact framed body size.
  const boundary = `agent-pages-${crypto.randomUUID()}`
  const manifest = { ...options.manifest, files: options.files.map((file, index) => ({ path: file.path, partName: `file${index}` })) }
  const parts: BlobPart[] = [`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n`]
  options.files.forEach(({ file }, index) => {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file${index}"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`, file, '\r\n')
  })
  parts.push(`--${boundary}--\r\n`)
  return new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` })
}

export function uploadMultipart<T>(path: string, options: {
  method: 'POST' | 'PUT'
  csrfToken: string
  body: Blob
  maxBytes: number
  signal: AbortSignal
  onProgress: (percent: number) => void
  onUploaded: () => void
}): Promise<T> {
  const body = options.body
  if (body.size > options.maxBytes) return Promise.reject(new ApiFailure('The complete upload exceeds the request size limit. Select fewer files.', 413, 'PAYLOAD_TOO_LARGE'))
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const cleanup = () => options.signal.removeEventListener('abort', abort)
    xhr.open(options.method, path)
    xhr.setRequestHeader('X-CSRF-Token', options.csrfToken)
    xhr.setRequestHeader('Content-Type', body.type)
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) options.onProgress(Math.floor(event.loaded / event.total * 100)) }
    xhr.upload.onload = options.onUploaded
    xhr.onload = () => {
      cleanup()
      let result: { error?: { message?: string; code?: string } } | undefined
      try { result = xhr.responseText ? JSON.parse(xhr.responseText) : undefined }
      catch { reject(new ApiFailure('The response could not be read. Retry the same publication.', 502)); return }
      if (xhr.status < 200 || xhr.status >= 300) reject(new ApiFailure(result?.error?.message ?? 'The request failed. Try again.', xhr.status, result?.error?.code))
      else resolve(result as T)
    }
    xhr.onerror = () => { cleanup(); reject(new ApiFailure('The connection was interrupted. Retry the same publication to check its result.', 0)) }
    xhr.onabort = () => { cleanup(); reject(new ApiFailure('Upload cancelled. Retry the same selection to check its result.', 0, 'ABORTED')) }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) { cleanup(); reject(new ApiFailure('Upload cancelled.', 0, 'ABORTED')); return }
    xhr.send(body)
  })
}

export async function readSiteManifest(siteId: string): Promise<{ site: SiteView; files: ManifestEntry[] }> {
  const path = `/web/sites/${encodeURIComponent(siteId)}`
  const site = await requestJson<SiteView>(path)
  const files: ManifestEntry[] = []
  let cursor: string | null = null
  do {
    const query: URLSearchParams = new URLSearchParams({ revisionId: site.revisionId, ...(cursor ? { cursor } : {}) })
    const page: FileListResponse = await requestJson<FileListResponse>(`${path}/files?${query}`)
    files.push(...page.files)
    cursor = page.cursor
  } while (cursor)
  return { site, files }
}

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export function isUnauthorized(error: unknown) {
  return error instanceof ApiFailure && error.status === 401
}

export function isVersionConflict(error: unknown) {
  return error instanceof ApiFailure && error.code === 'VERSION_CONFLICT'
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value))
}

export function formatRelative(value: string) {
  const elapsed = Date.now() - new Date(value).getTime()
  const minutes = Math.max(0, Math.floor(elapsed / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  return formatDate(value)
}
