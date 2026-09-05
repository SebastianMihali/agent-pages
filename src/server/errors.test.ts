import { expect, it } from 'vitest'
import { isDomainError, errorResponse } from './errors'

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
