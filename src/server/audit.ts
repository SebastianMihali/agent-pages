export type AuditEvent =
  | { event: 'login_succeeded'; ownerId: string }
  | { event: 'login_rejected' | 'login_rate_limited' }
  | { event: 'key_created' | 'key_revoked'; ownerId: string; keyId: string }
  | { event: 'site_visibility_changed'; ownerId: string; siteId: string; operationId: string; visibility: 'private' | 'public' }
  | { event: 'site_deleted'; ownerId: string; siteId: string; operationId: string }

const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '[invalid]'

export function audit(input: AuditEvent): void {
  // Project fields explicitly: structurally typed callers can carry additional secrets.
  const record: Record<string, string> = { event: input.event }
  switch (input.event) {
    case 'login_succeeded':
      record.ownerId = safeId(input.ownerId)
      break
    case 'key_created':
    case 'key_revoked':
      record.ownerId = safeId(input.ownerId)
      record.keyId = safeId(input.keyId)
      break
    case 'site_visibility_changed':
    case 'site_deleted':
      record.ownerId = safeId(input.ownerId)
      record.siteId = safeId(input.siteId)
      record.operationId = safeId(input.operationId)
      if (input.event === 'site_visibility_changed') record.visibility = input.visibility === 'public' ? 'public' : 'private'
      break
    case 'login_rejected':
    case 'login_rate_limited':
      break
    default:
      return
  }
  try {
    console.info(JSON.stringify(record))
  } catch {
    // A failed log sink must not make a committed mutation appear to have failed.
  }
}
