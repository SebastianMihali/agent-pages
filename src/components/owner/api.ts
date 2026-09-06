import type { ManifestEntry, SiteView } from '../../server/sites'

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

export type ApiKeySummary = {
  id: string
  label: string
  prefix: string
  createdAt: string
}

export type CreatedApiKey = ApiKeySummary & { key: string }

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number) {
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
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: { message?: string } }
        if (body.error?.message) message = body.error.message
      } catch {
        // Keep the safe fallback for malformed upstream responses.
      }
    }
    throw new ApiFailure(message, response.status)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export function isUnauthorized(error: unknown) {
  return error instanceof ApiFailure && error.status === 401
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
