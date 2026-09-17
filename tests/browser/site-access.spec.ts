import { expect, test } from '@playwright/test'
import { bearer, createSite, issueKey, signIn, uploadFont } from './support'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#2563eb"/></svg>`

test('private content opens for its owner with static assets and explicit visibility changes', async ({ browser, page }) => {
  console.log(`browser=${browser.browserType().name()} version=${browser.version()}`)
  await signIn(page)
  const key = await issueKey(page, `Content ${browser.browserType().name()} ${Date.now()}`)
  const unsafeName = `<img src=x onerror=alert('site')> ${browser.browserType().name()}`
  const unsafePath = `assets/<script>alert('file')</script>.txt`
  const created = await createSite(page.request, key, unsafeName, [
    { path: 'index.html', content: `<!doctype html><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script><h1>Private site</h1><img src="/assets/mark.svg" alt="Blue marker"><a href="/guide?from=root">Guide</a>` },
    { path: 'guide/index.html', content: '<!doctype html><h1>Nested guide</h1>' },
    { path: 'assets/site.css', content: `@font-face{font-family:Fixture;src:url('/assets/test-font.woff')}body{color:rgb(37,99,235);font-family:Fixture,sans-serif}` },
    { path: 'assets/site.js', content: `document.documentElement.dataset.fixtureScript='loaded'` },
    { path: 'assets/mark.svg', content: svg },
    { path: unsafePath, content: 'The name remains text.' },
    { path: '404.html', content: '<!doctype html><h1>Fixture page not found</h1>' },
  ])
  expect(created.site.visibility).toBe('private')
  const uploaded = await uploadFont(page.request, key, created.site)
  const site = uploaded.site

  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    for (const path of ['/', '/guide/', '/assets/site.css', '/assets/site.js', '/assets/mark.svg', '/assets/test-font.woff', '/missing']) {
      const denied = await anonymous.request.get(`${site.url}${path}`, { maxRedirects: 0 })
      expect(denied.status(), `private anonymous GET ${path}`).toBe(404)
      expect(denied.headers()['cache-control']).toBe('no-store')
    }
    expect((await anonymous.request.head(site.url, { maxRedirects: 0 })).status()).toBe(404)

    await page.getByRole('button', { name: 'Sites' }).click()
    await page.getByRole('button', { name: 'Refresh site list' }).click()
    await page.getByRole('button').getByText(unsafeName, { exact: true }).click()
    await expect(page.getByRole('heading', { name: unsafeName })).toBeVisible()
    await expect(page.getByRole('button').getByText(unsafePath, { exact: true })).toBeVisible()
    expect(await page.locator('img[src="x"]').count()).toBe(0)
    expect(await page.locator('script').allTextContents()).not.toContain("alert('file')")
    if (browser.browserType().name() === 'chromium') {
      await page.screenshot({ path: 'test-results/owner-desktop.png', fullPage: true })
    }

    const assetResponses = new Map<string, number>()
    page.context().on('response', (response) => {
      if (response.url().startsWith(site.url)) assetResponses.set(new URL(response.url()).pathname, response.status())
    })
    const [content] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: 'Open site' }).click(),
    ])
    await expect(content.getByRole('heading', { name: 'Private site' })).toBeVisible()
    await expect(content.getByAltText('Blue marker')).toBeVisible()
    await expect.poll(() => content.evaluate(() => document.documentElement.dataset.fixtureScript)).toBe('loaded')
    await expect.poll(() => assetResponses.get('/assets/test-font.woff')).toBe(200)
    expect(await content.locator('body').evaluate((body) => getComputedStyle(body).color)).toBe('rgb(37, 99, 235)')
    expect((await content.request.get(`${site.url}/assets/site.css`)).headers()['cache-control']).toBe('no-store')

    await content.goto(`${site.url}/guide?from=test`)
    await expect(content).toHaveURL(`${site.url}/guide/?from=test`)
    await expect(content.getByRole('heading', { name: 'Nested guide' })).toBeVisible()
    const missing = await content.goto(`${site.url}/not-here`)
    expect(missing?.status()).toBe(404)
    await expect(content.getByRole('heading', { name: 'Fixture page not found' })).toBeVisible()
    const head = await content.request.head(site.url)
    expect(head.status()).toBe(200)
    expect((await head.body()).byteLength).toBe(0)

    const stale = await page.request.put(`/api/sites/${site.id}/files`, {
      headers: bearer(key),
      data: { operationId: crypto.randomUUID(), expectedVersion: created.site.version, files: [{ path: 'stale.txt', content: 'stale' }] },
    })
    expect(stale.status()).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT', retryable: false } })

    await page.getByRole('button', { name: 'Make public' }).click()
    await page.getByRole('button', { name: 'Confirm public access' }).click()
    await expect(page.getByText('Public', { exact: true })).toBeVisible()
    for (const path of ['/', '/guide/', '/assets/site.css', '/assets/site.js', '/assets/mark.svg', '/assets/test-font.woff']) {
      expect((await anonymous.request.get(`${site.url}${path}`)).status(), `public anonymous GET ${path}`).toBe(200)
    }
    const redirect = await anonymous.request.get(`${site.url}/guide?keep=yes`, { maxRedirects: 0 })
    expect(redirect.status()).toBe(308)
    expect(redirect.headers().location).toBe('/guide/?keep=yes')
    const publicMissing = await anonymous.request.get(`${site.url}/still-missing`)
    expect(publicMissing.status()).toBe(404)
    expect(await publicMissing.text()).toContain('Fixture page not found')

    await page.getByRole('button', { name: 'Make private' }).click()
    await expect(page.getByText('Private', { exact: true })).toBeVisible()
    expect((await anonymous.request.get(site.url, { maxRedirects: 0 })).status()).toBe(404)
    expect((await content.request.get(`${site.url}/assets/site.css`, { maxRedirects: 0 })).status()).toBe(404)

    const [reopened] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: 'Open site' }).click(),
    ])
    await expect(reopened.getByRole('heading', { name: 'Private site' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    expect((await reopened.request.get(`${site.url}/assets/site.css`, { maxRedirects: 0 })).status()).toBe(404)

    await page.goto(`${site.url}/guide/?deep=yes`)
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    const loginDestination = new URL(page.url())
    expect(loginDestination.origin).toBe('https://app.agent-pages.localhost:3443')
    expect(loginDestination.searchParams.get('site')).toBe(site.id)
    expect(loginDestination.searchParams.get('returnPath')).toBe('/guide/?deep=yes')
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password').fill('correct test password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: unsafeName })).toBeVisible()
    const [deepLink] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: 'Open site' }).click(),
    ])
    await expect(deepLink).toHaveURL(`${site.url}/guide/?deep=yes`)
    await expect(deepLink.getByRole('heading', { name: 'Nested guide' })).toBeVisible()
  } finally {
    await anonymous.close()
  }
})
