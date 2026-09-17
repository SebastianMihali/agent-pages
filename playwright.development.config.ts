import { defineConfig } from '@playwright/test'

const appOrigin = 'http://app.agent-pages.localhost:3553'

export default defineConfig({
  testDir: './tests/development',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL: appOrigin,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec tsx scripts/browser-dev-test-server.ts',
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${appOrigin}/health/live`,
  },
})
