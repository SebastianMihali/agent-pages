import { expect, test } from '@playwright/test'
import { createSite, issueKey, setVisibility, signIn } from '../browser/support'

test('a site host serves its own styles, scripts and images in the development runtime', async ({ page }) => {
  await signIn(page)
  const key = await issueKey(page, `Development assets ${Date.now()}`)
  const created = await createSite(page.request, key, `Development assets ${Date.now()}`, [
    { path: 'index.html', content: '<!doctype html><link rel="stylesheet" href="styles.css"><h1>Styled</h1>' },
    { path: 'styles.css', content: 'h1 { color: rgb(1, 2, 3); }' },
    // This path also exists in the application source served by Vite.
    { path: 'src/styles.css', content: '/* site stylesheet */' },
    { path: 'app.js', content: '/* site script */' },
    { path: 'logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  ])
  const { site } = await setVisibility(page.request, key, created.site, 'public')

  for (const [path, type, body] of [
    ['styles.css', 'text/css', 'h1 { color: rgb(1, 2, 3); }'],
    ['src/styles.css', 'text/css', '/* site stylesheet */'],
    ['app.js', 'text/javascript', '/* site script */'],
    ['logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ]) {
    const response = await page.request.get(`${site.url}/${path}`)
    expect(response.status(), path).toBe(200)
    expect(response.headers()['content-type'], path).toContain(type)
    expect(await response.text(), path).toBe(body)
  }

  await page.goto(site.url)
  await expect(page.getByRole('heading', { name: 'Styled' })).toHaveCSS('color', 'rgb(1, 2, 3)')
})
