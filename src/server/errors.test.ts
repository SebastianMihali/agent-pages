import { expect, it, vi } from 'vitest'
import { DomainError, isDomainError, errorResponse, logFailure } from './errors'

it('preserves domain errors across separately bundled Nitro and SSR modules', async () => {
  // A second bundle defines its own constructor but shares the process-wide brand.
  const tag = Symbol.for('agent-pages.domain-error')
  class OtherBundleError extends Error {
    readonly [tag] = true
    readonly code = 'VERSION_CONFLICT'
    readonly status = 409
    readonly retryable = false
    readonly details = { currentVersion: 2 }
  }
  const response = errorResponse(new OtherBundleError('Site version changed'))
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe('VERSION_CONFLICT')
  expect(isDomainError({ code: 'NOT_FOUND', [Symbol.for('agent-pages.domain-error')]: true })).toBe(false)
})

it('logs storage and foreign failures with their cause and keeps expected outcomes quiet', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const conflict = errorResponse(new DomainError('VERSION_CONFLICT', 'Site version does not match'))
    expect(conflict.status).toBe(409)
    expect(logged).not.toHaveBeenCalled()

    const disk = Object.assign(new Error("EACCES: permission denied, open '/data/sites/x/manifest.json'"), { code: 'EACCES' })
    const wrapped = await errorResponse(new DomainError('STORAGE_UNAVAILABLE', 'The site operation could not be completed', undefined, { cause: disk })).json()
    expect(logged).toHaveBeenCalledTimes(1)
    const record = JSON.parse(logged.mock.calls[0]![0] as string) as Record<string, unknown>
    expect(record).toMatchObject({ event: 'request_failed', requestId: wrapped.error.requestId, code: 'STORAGE_UNAVAILABLE',
      cause: { name: 'Error', message: disk.message, code: 'EACCES' } })
    // The response still hides the cause from the client.
    expect(JSON.stringify(wrapped)).not.toContain('EACCES')

    logFailure('cleanup_failed', new TypeError('database is closed'))
    expect(JSON.parse(logged.mock.calls[1]![0] as string)).toEqual({ event: 'cleanup_failed', cause: { name: 'TypeError', message: 'database is closed' } })
  } finally { logged.mockRestore() }
})
