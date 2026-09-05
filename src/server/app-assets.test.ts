import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveAppAsset } from './app-assets'

it('serves a built application asset without exposing files outside its asset directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agp-assets-'))
  try {
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'app-abcd.js'), 'console.log("app")')
    await writeFile(join(root, 'private.txt'), 'outside')
    const response = await serveAppAsset(new Request('https://app.example.com/assets/app-abcd.js'), root)
    expect(response?.headers.get('content-type')).toContain('javascript')
    expect(await response?.text()).toBe('console.log("app")')
    const traversal = await serveAppAsset(new Request('https://app.example.com/assets/%2e%2e%2fprivate.txt'), root)
    expect(traversal?.status).toBe(404)
  } finally { await rm(root, { recursive: true, force: true }) }
})
