import { DomainError } from './errors'

export async function readBody(request: Request, maximumBytes: number, deadlineMs = 30_000): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel()
    throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit')
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  let expired = false
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, deadlineMs)
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (expired) throw new DomainError('BUSY', 'Request body deadline exceeded')
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured limit')
      }
      chunks.push(chunk.value)
    }
  } finally { clearTimeout(timer); reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

export async function readJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json')
  }
  const body = await readBody(request, maximumBytes)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) }
  catch { throw new DomainError('INVALID_INPUT', 'Request body must be valid UTF-8 JSON') }
}
