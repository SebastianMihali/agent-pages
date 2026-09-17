import { afterEach, expect, it, vi } from 'vitest'
import { audit } from './audit'

afterEach(() => vi.restoreAllMocks())

it('writes only allowlisted fields and bounds unsafe identifiers', () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {})
  audit({ event: 'key_created', ownerId: 'owner-1', keyId: 'key-1', ...{ password: 'secret-password', label: 'secret-label' } })
  audit({ event: 'site_visibility_changed', ownerId: 'owner-1', siteId: 'bad\nsecret', operationId: 'operation-1', visibility: 'public' })
  expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    { event: 'key_created', ownerId: 'owner-1', keyId: 'key-1' },
    { event: 'site_visibility_changed', ownerId: 'owner-1', siteId: '[invalid]', operationId: 'operation-1', visibility: 'public' },
  ])
  expect(JSON.stringify(output.mock.calls)).not.toContain('secret')
})

it('does not turn a committed operation into a failure when the log sink throws', () => {
  vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('unavailable sink') })
  expect(() => audit({ event: 'login_succeeded', ownerId: 'owner-1' })).not.toThrow()
})
