import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  // One production installation is shared by the projects. Serial workers avoid
  // turning the deliberate password-verification bound into fixture contention.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: {
    baseURL: 'https://app.agent-pages.localhost:3443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm exec tsx scripts/browser-test-server.ts',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'https://app.agent-pages.localhost:3443/health/live',
  },
})
