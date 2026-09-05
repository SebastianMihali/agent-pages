import { expect, it } from 'vitest'
import { createAdmission } from './admission'
import { readBody } from './body'

it('bounds admitted requests and frees the slot after failures', async () => {
  const admit = createAdmission(1)
  let finish!: () => void
  const pending = admit(() => new Promise<void>((resolve) => { finish = resolve }))
  await expect(admit(async () => {})).rejects.toMatchObject({ code: 'BUSY' })
  finish()
  await pending
  await expect(admit(async () => { throw new Error('fixture') })).rejects.toThrow('fixture')
  await expect(admit(async () => 'done')).resolves.toBe('done')
})

it('cancels a stalled body on its deadline instead of retaining an admission forever', async () => {
  let canceled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
  const request = new Request('https://app.example.com/api/sites', { method: 'POST', body, duplex: 'half' } as RequestInit)
  await expect(readBody(request, 1024, 10)).rejects.toMatchObject({ code: 'BUSY' })
  expect(canceled).toBe(true)
})
