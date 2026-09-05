import { describe, expect, it } from 'vitest'
import { parseConfig } from './config'

const credentials = {
  ADMIN_USERNAME: 'owner',
  ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}`,
}

describe('installation configuration', () => {
  it('accepts isolated HTTPS hosts and bounded default limits', () => {
    const config = parseConfig({
      ...credentials,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://app.example.com',
      CONTENT_BASE_DOMAIN: 'sites.example.com',
      DATA_DIR: '/tmp/agent-pages-test',
    })
    expect(config.appOrigin).toBe('https://app.example.com')
    expect(config.limits.maxSiteBytes).toBe(50 * 1024 * 1024)
    expect(config.secureCookies).toBe(true)
  })
  it.each([
    { APP_ORIGIN: 'http://app.example.com' },
    { APP_ORIGIN: 'https://app.example.com/private' },
    { CONTENT_BASE_DOMAIN: 'app.example.com' },
    { CONTENT_BASE_DOMAIN: 'example.com' },
    { MAX_FILE_SIZE_MB: '100' },
    { MAX_BATCH_FILES: '501' },
    { ADMIN_PASSWORD_HASH: 'secret-plaintext-password' },
  ])('rejects insecure or incoherent production configuration', (overrides) => {
    expect(() => parseConfig({ ...credentials, NODE_ENV: 'production',
      APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
      DATA_DIR: '/tmp/agent-pages-test', ...overrides,
    })).toThrow()
  })
  it('reports credential field names without their values', () => {
    expect(() => parseConfig({ ...credentials, ADMIN_PASSWORD_HASH: 'do-not-leak',
      APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
    })).toThrow('Invalid configuration fields: ADMIN_PASSWORD_HASH')
  })
})
