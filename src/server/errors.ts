export type ErrorCode = 'UNAUTHENTICATED' | 'NOT_FOUND' | 'SITE_EXPIRED' | 'INVALID_INPUT' | 'INVALID_PATH' |
  'UNSUPPORTED_MEDIA_TYPE' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_UNAVAILABLE' |
  'PAYLOAD_TOO_LARGE' | 'QUOTA_EXCEEDED' | 'RATE_LIMITED' | 'BUSY' | 'STORAGE_UNAVAILABLE'

const statuses: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401, NOT_FOUND: 404, SITE_EXPIRED: 410, INVALID_INPUT: 400, INVALID_PATH: 400,
  UNSUPPORTED_MEDIA_TYPE: 415, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409,
  REVISION_UNAVAILABLE: 409, PAYLOAD_TOO_LARGE: 413, QUOTA_EXCEEDED: 409, RATE_LIMITED: 429,
  BUSY: 503, STORAGE_UNAVAILABLE: 503,
}

const domainErrorTag = Symbol.for('agent-pages.domain-error')

export class DomainError extends Error {
  readonly [domainErrorTag] = true
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options)
  }
  get status() { return statuses[this.code] }
  get retryable() { return ['BUSY', 'RATE_LIMITED', 'STORAGE_UNAVAILABLE'].includes(this.code) }
}

/** Runtime and HTTP adapters are compiled into separate Nitro/SSR bundles. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof Error && domainErrorTag in value && value[domainErrorTag] === true
}

export type Principal = Readonly<{ ownerId: string }>

function describeCause(value: unknown) {
  if (!(value instanceof Error)) return { name: 'Unknown', message: String(value) }
  const code = (value as { code?: unknown }).code
  return { name: value.name, message: value.message, ...(typeof code === 'string' ? { code } : {}) }
}

/**
 * Records a failure an operator must act on. Domain outcomes without a cause
 * (conflicts, denials, limits) are expected results and stay out of the log;
 * storage failures and foreign errors are logged with their underlying cause.
 * Responses remain unchanged, so the cause never reaches the client.
 */
export function logFailure(event: string, error: unknown, fields: Record<string, string> = {}) {
  if (isDomainError(error) && error.code !== 'STORAGE_UNAVAILABLE' && error.cause === undefined) return
  const cause = isDomainError(error) && error.cause !== undefined ? error.cause : error
  console.error(JSON.stringify({ event, ...fields, ...(isDomainError(error) ? { code: error.code } : {}), cause: describeCause(cause) }))
}

export function errorResponse(error: unknown): Response {
  const known = isDomainError(error) ? error : new DomainError('STORAGE_UNAVAILABLE', 'The operation could not be completed', undefined, { cause: error })
  const requestId = crypto.randomUUID()
  logFailure('request_failed', error, { requestId })
  return Response.json({ error: {
    code: known.code, message: known.message, retryable: known.retryable, requestId,
    ...(known.details ? { details: known.details } : {}),
  } }, { status: known.status, headers: {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(known.retryable ? { 'retry-after': '60' } : {}),
  } })
}

export function requireOrigin(request: Request, origin: string, required = true) {
  const supplied = request.headers.get('origin')
  if ((required || supplied !== null) && supplied !== origin) {
    throw new DomainError('UNAUTHENTICATED', 'Request origin is not permitted')
  }
}
