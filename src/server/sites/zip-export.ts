import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { ZipFile } from 'yazl'
import { DomainError } from '../errors'
import type { RevisionLease } from '.'

export function streamZip(lease: RevisionLease, signal: AbortSignal, onClosed: () => void): ReadableStream<Uint8Array> {
  const zip = new ZipFile()
  // yazl exposes a Node PassThrough; its published type only declares ReadableStream.
  const output = zip.outputStream as Readable
  const reader = output[Symbol.asyncIterator]()
  let input: Readable | undefined
  let opening = Promise.resolve()
  const abort = () => fail(signal.reason)
  let stopped = false
  let cleanup: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>

  function close() {
    if (cleanup) return cleanup
    stopped = true
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    cleanup = (async () => {
      try {
        output.destroy()
        await finished(output).catch(() => {})
        await opening
        if (input) { input.destroy(); await finished(input).catch(() => {}) }
        await lease.release()
      } finally { onClosed() }
    })()
    return cleanup
  }

  function fail(error: unknown) {
    if (stopped) return
    controller.error(new DomainError('STORAGE_UNAVAILABLE', 'The site export could not be completed', undefined, { cause: error }))
    void close()
  }

  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    async pull(value) {
      try {
        const part = await reader.next()
        if (stopped) return
        if (part.done) { await close(); value.close() }
        else value.enqueue(part.value)
      } catch (error) { fail(error) }
    },
    cancel: close,
  }, { highWaterMark: 0 })
  zip.on('error', fail)
  output.on('error', fail)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => fail(new Error('Site export deadline exceeded')), 300_000)
  timer.unref()
  if (signal.aborted) { abort(); return body }
  try {
    for (const entry of lease.manifest) {
      // These are valid existing POSIX names. Mark them relative so ZIP readers
      // do not mistake the first segment for a Windows drive; extraction keeps the name.
      const archivePath = /^[a-zA-Z]:/.test(entry.path) ? `./${entry.path}` : entry.path
      // Stored entries keep CPU bounded and avoid compression resources on cancellation.
      zip.addReadStreamLazy(archivePath, { size: entry.sizeBytes, compress: false }, (callback) => {
        if (stopped) return
        opening = lease.open(entry.path).then(async (file) => {
          if (stopped) { await file.body.cancel(); return }
          // DOM and Node stream types differ in their BYOB declarations at this adapter.
          input = Readable.fromWeb(file.body as unknown as NodeReadableStream<Uint8Array>)
          input.on('error', fail)
          callback(null, input)
        }).catch(fail)
      })
    }
    zip.end()
  } catch (error) { fail(error) }
  return body
}
