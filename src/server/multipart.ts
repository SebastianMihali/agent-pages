import Busboy from 'busboy'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import type { AppConfig } from './config'
import { DomainError, isDomainError } from './errors'
import { parseSiteInput } from './site-input'
import type { BinaryFileInput } from './sites'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // A parser error can precede the domain consumer reaching a later file.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export async function readMultipart<Fields extends Record<string, unknown>>(request: Request, config: AppConfig,
  options: { fields: z.ZodType<Fields>; deadlineMs?: number }) {
  const maximumBytes = config.limits.maxMultipartBodyBytes
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel()
    throw new DomainError('PAYLOAD_TOO_LARGE', 'Multipart body exceeds the configured limit')
  }
  if (!request.body) throw new DomainError('INVALID_INPUT', 'Multipart body is required')
  const manifestSchema = z.looseObject({ files: z.array(z.strictObject({
    path: z.string().min(1).max(512), partName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  })).min(1).max(config.limits.maxBatchFiles) }).transform(({ files, ...fields }) => ({
    ...parseSiteInput(options.fields, fields), files,
  }))
  type Manifest = z.infer<typeof manifestSchema>
  const ready = deferred<Manifest>()
  const completed = deferred<void>()
  let manifest: Manifest | undefined
  const fileWaiters: Array<ReturnType<typeof deferred<Readable>>> = []
  const streams = new Set<Readable>()
  let fileIndex = 0
  let failure: DomainError | undefined
  let parser: ReturnType<typeof Busboy>
  try {
    parser = Busboy({ headers: { 'content-type': request.headers.get('content-type') ?? '' },
      limits: { fields: 1, fieldSize: config.limits.maxJsonBodyBytes, files: config.limits.maxBatchFiles,
        parts: config.limits.maxBatchFiles + 1, fileSize: config.limits.maxFileBytes + 1 },
      highWaterMark: 16384, fileHwm: 16384,
    })
  } catch {
    await request.body.cancel()
    throw new DomainError('INVALID_INPUT', 'Multipart boundary is invalid or missing')
  }
  const reader = request.body.getReader()
  function fail(cause: unknown) {
    if (failure) return
    failure = isDomainError(cause) ? cause : new DomainError('INVALID_INPUT', 'Multipart body is malformed')
    ready.reject(failure)
    completed.reject(failure)
    for (const waiter of fileWaiters) waiter.reject(failure)
    for (const stream of streams) stream.destroy(failure)
    parser.destroy(failure)
    void reader.cancel().catch(() => {})
  }
  parser.on('field', (name, value, info) => {
    try {
      if (manifest || name !== 'manifest' || fileIndex || info.valueTruncated || info.nameTruncated) {
        throw new DomainError('INVALID_INPUT', 'The first multipart part must be a bounded manifest JSON field')
      }
      manifest = parseSiteInput(manifestSchema, JSON.parse(value))
      if (new Set(manifest.files.map((file) => file.partName)).size !== manifest.files.length) {
        throw new DomainError('INVALID_INPUT', 'Multipart part names must be unique')
      }
      for (let index = 0; index < manifest.files.length; index++) fileWaiters.push(deferred<Readable>())
      ready.resolve(manifest)
    } catch (error) { fail(error) }
  })
  parser.on('file', (name, stream) => {
    streams.add(stream)
    stream.on('error', () => {})
    stream.on('limit', () => fail(new DomainError('PAYLOAD_TOO_LARGE', 'Multipart file exceeds the configured limit')))
    if (!manifest || manifest.files[fileIndex]?.partName !== name) {
      fail(new DomainError('INVALID_INPUT', 'File parts must follow the manifest once each, in order'))
      return
    }
    fileWaiters[fileIndex++].resolve(stream)
  })
  for (const event of ['fieldsLimit', 'filesLimit', 'partsLimit'] as const) {
    parser.on(event, () => fail(new DomainError('INVALID_INPUT', 'Multipart contains excessive or unexpected parts')))
  }
  parser.on('error', fail)
  parser.on('close', () => {
    if (failure) return
    if (!manifest || fileIndex !== manifest.files.length) fail(new DomainError('INVALID_INPUT', 'Multipart is missing referenced parts'))
    else completed.resolve()
  })
  const onAbort = () => fail(new DomainError('INVALID_INPUT', 'Multipart upload was interrupted'))
  request.signal.addEventListener('abort', onAbort, { once: true })
  const deadlineMs = options.deadlineMs ?? 30_000
  const deadline = setTimeout(() => fail(new DomainError('BUSY', `Multipart upload exceeded its ${deadlineMs / 1000}-second deadline`)), deadlineMs)
  deadline.unref()
  if (request.signal.aborted) onAbort()
  const pump = (async () => {
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > maximumBytes) throw new DomainError('PAYLOAD_TOO_LARGE', 'Multipart body exceeds the configured limit')
        if (!parser.write(chunk.value)) await Promise.race([once(parser, 'drain'), completed.promise])
      }
      parser.end()
      await completed.promise
    } catch (error) { fail(error) }
    finally { clearTimeout(deadline); reader.releaseLock(); request.signal.removeEventListener('abort', onAbort) }
  })()
  try {
    const value = await ready.promise
    if (failure) throw failure
    const files: BinaryFileInput[] = value.files.map((entry, index) => ({ path: entry.path, maximumBytes: config.limits.maxFileBytes,
      body: (async function* () {
        try {
          const stream = await fileWaiters[index].promise
          for await (const chunk of stream) {
            if (failure) throw failure
            yield chunk as Buffer
          }
          // Do not let the domain publish until trailing parts and framing have been validated.
          if (index === value.files.length - 1) await completed.promise
          if (failure) throw failure
        } catch (error) {
          fail(error)
          throw failure
        }
      })(),
    }))
    return {
      manifest: value, files, maximumUploadBytes: maximumBytes,
      async close() {
        if (!parser.closed) fail(new DomainError('INVALID_INPUT', 'Multipart upload was interrupted'))
        await pump
      },
    }
  } catch (error) { fail(error); await pump; throw error }
}
