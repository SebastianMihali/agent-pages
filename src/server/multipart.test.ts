import { describe, expect, it, vi } from 'vitest'
import { parseConfig } from './config'
import { readMultipart } from './multipart'
import { siteInputSchemas } from './site-input'

const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: 'https://app.example.com', CONTENT_BASE_DOMAIN: 'sites.example.com',
  DATA_DIR: '/tmp/unused-multipart-fixture', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD_HASH: `scrypt$131072$8$1$${'aa'.repeat(16)}$${'bb'.repeat(32)}` })
const schemas = siteInputSchemas(config)

describe('streaming multipart interface', () => {
  it('validates creation fields and yields binary parts through the same interface as writes', async () => {
    const fields = { operationId: crypto.randomUUID(), name: 'Created in browser', expiresInSeconds: null }
    const form = new FormData()
    form.set('manifest', JSON.stringify({ ...fields, files: [{ path: 'index.html', partName: 'home' }, { path: 'guide.pdf', partName: 'pdf' }] }))
    form.set('home', new Blob(['home']), 'index.html')
    form.set('pdf', new Blob([new Uint8Array([37, 80, 68, 70, 0, 255])]), 'guide.pdf')
    const encoded = new Request(config.appOrigin, { method: 'POST', body: form })
    const request = new Request(config.appOrigin, { method: 'POST', headers: encoded.headers, body: await encoded.arrayBuffer() })
    const upload = await readMultipart(request, config, { fields: schemas.create.omit({ files: true }) })
    try {
      expect(upload.manifest).toEqual({ ...fields, files: [{ path: 'index.html', partName: 'home' }, { path: 'guide.pdf', partName: 'pdf' }] })
      const contents: Buffer[] = []
      for (const file of upload.files) {
        const chunks: Uint8Array[] = []
        for await (const chunk of file.body as AsyncIterable<Uint8Array>) chunks.push(chunk)
        contents.push(Buffer.concat(chunks))
      }
      expect(contents).toEqual([Buffer.from('home'), Buffer.from([37, 80, 68, 70, 0, 255])])
    } finally { await upload.close() }
  })

  it.each([{ configured: undefined, duration: 30_000 }, { configured: 120_000, duration: 120_000 }])(
    'cancels a stalled body after $duration milliseconds', async ({ configured, duration }) => {
      vi.useFakeTimers()
      let cancelled = false
      try {
        const request = new Request(config.appOrigin, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
          body: new ReadableStream({ cancel() { cancelled = true } }), duplex: 'half' } as RequestInit)
        const promise = readMultipart(request, config, { fields: schemas.delete, deadlineMs: configured })
        const outcome = expect(promise).rejects.toMatchObject({ code: 'BUSY', message: `Multipart upload exceeded its ${duration / 1000}-second deadline` })
        await vi.advanceTimersByTimeAsync(duration - 1)
        expect(cancelled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await outcome
        expect(cancelled).toBe(true)
      } finally { vi.useRealTimers() }
    })

  it('rejects write-only and unknown fields in a creation manifest', async () => {
    for (const extra of [{ expectedVersion: 1 }, { csrfToken: 'body-csrf-is-not-used' }]) {
      const form = new FormData()
      form.set('manifest', JSON.stringify({ operationId: crypto.randomUUID(), name: 'Invalid', ...extra,
        files: [{ path: 'index.html', partName: 'home' }] }))
      form.set('home', new Blob(['home']), 'index.html')
      const encoded = new Request(config.appOrigin, { method: 'POST', body: form })
      const request = new Request(config.appOrigin, { method: 'POST', headers: encoded.headers, body: await encoded.arrayBuffer() })
      await expect(readMultipart(request, config, { fields: schemas.create.omit({ files: true }) })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  })
})
