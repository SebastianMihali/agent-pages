import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ManifestEntry, SiteView } from '../../server/sites'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { ApiFailure, formatBytes, isUnauthorized, isVersionConflict, messageFrom, publicationBody, readSiteManifest, requestJson, uploadMultipart } from './api'
import type { BrowserSettings, Session } from './api'
import { ErrorMessage } from './error-message'
import { planPublication } from './publication-plan'

export type PickedFile = { relativePath: string; file: File }

async function droppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  const result: PickedFile[] = []
  async function visit(entry: FileSystemEntry, prefix = ''): Promise<void> {
    const relativePath = `${prefix}${entry.name}`
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      result.push({ relativePath, file })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!entries.length) break
        for (const child of entries) await visit(child, `${relativePath}/`)
      }
    }
  }
  // Capture entries synchronously: the browser clears DataTransfer after the event.
  const entries = Array.from(transfer.items).filter((item) => item.kind === 'file').map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }))
  for (const { entry, file } of entries) {
    if (entry) await visit(entry)
    else if (file) result.push({ relativePath: file.name, file })
  }
  return result
}

export function PublicationPicker({ onPick, disabled, children }: { onPick: (files: PickedFile[]) => void; disabled?: boolean; children?: ReactNode }) {
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  function choose(files: FileList | null) {
    if (files?.length) onPick(Array.from(files, (file) => ({ relativePath: file.webkitRelativePath || file.name, file })))
  }
  return <div className={dragging ? 'rounded-lg outline-2 outline-blue-400' : undefined}
    onDragOver={(event) => { event.stopPropagation(); if (!disabled) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={(event) => {
      event.preventDefault(); event.stopPropagation(); setDragging(false)
      if (disabled || reading) return
      setReading(true); setError(null)
      void droppedFiles(event.dataTransfer).then(onPick).catch((cause: unknown) => setError(messageFrom(cause))).finally(() => setReading(false))
    }}>
    <div className="flex flex-wrap items-center gap-2 py-3">
      <input aria-label="Upload files" className="hidden" type="file" multiple ref={filesInput} disabled={disabled || reading}
        onChange={(event) => { choose(event.target.files); event.target.value = '' }} />
      <input aria-label="Upload folder" className="hidden" type="file" multiple ref={(node) => { folderInput.current = node; node?.setAttribute('webkitdirectory', '') }} disabled={disabled || reading}
        onChange={(event) => { choose(event.target.files); event.target.value = '' }} />
      <Button size="small" variant="secondary" disabled={disabled || reading} onClick={() => filesInput.current?.click()}>Upload files</Button>
      <Button size="small" variant="secondary" disabled={disabled || reading} onClick={() => folderInput.current?.click()}>Upload folder</Button>
      <span className="text-xs text-slate-500">{reading ? 'Reading folder…' : 'Or drop files or folders here.'}</span>
    </div>
    {error && <ErrorMessage>{error}</ErrorMessage>}
    {children}
  </div>
}

export function PublicationDialog({ site: initialSite, settings, initialPicked = [], onClose, onPublished }: {
  site?: SiteView
  settings: BrowserSettings
  initialPicked?: PickedFile[]
  onClose: () => void
  onPublished: (site: SiteView) => void
}) {
  const [picked, setPicked] = useState(initialPicked)
  const [name, setName] = useState('')
  const [site, setSite] = useState(initialSite)
  const [existing, setExisting] = useState<ManifestEntry[]>([])
  const [loading, setLoading] = useState(!!initialSite)
  const [ready, setReady] = useState(!initialSite)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [uploaded, setUploaded] = useState(false)
  const uploadedRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  const [uncertain, setUncertain] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const create = !initialSite

  useEffect(() => {
    let active = true
    if (initialSite) void readSiteManifest(initialSite.id).then((result) => {
      if (active) { setSite(result.site); setExisting(result.files); setReady(true) }
    }).catch((cause: unknown) => { if (active) setError(messageFrom(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.current?.abort() }
  }, [initialSite?.id])

  const plan = useMemo(() => planPublication({ mode: create ? 'create' : 'write', picked: picked.map(({ relativePath, file }) => ({ relativePath, sizeBytes: file.size })), existing, limits: settings.limits }), [create, picked, existing, settings.limits])
  const body = useMemo(() => publicationBody({
    manifest: create ? { operationId, name: name.trim() } : { operationId, expectedVersion: site?.version },
    files: plan.files.map(({ path, index }) => ({ path, file: picked[index].file })),
  }), [create, operationId, name, site?.version, plan.files, picked])
  const blockers = [...plan.blockers,
    ...(create && name.trim().length > 100 ? ['Site name must be 100 characters or fewer.'] : []),
    ...(body.size > settings.limits.maxMultipartBodyBytes ? ['The complete upload exceeds the request size limit. Select fewer files.'] : []),
  ]

  function choose(files: PickedFile[]) {
    setPicked(files); setError(null); setOperationId(crypto.randomUUID())
    if (create && !name) {
      const folder = files[0]?.relativePath.split('/')
      if (folder && folder.length > 1) setName(folder[0])
    }
  }

  async function reload() {
    if (!site || loading) return
    setLoading(true); setError(null)
    try {
      const latest = await readSiteManifest(site.id)
      setSite(latest.site); setExisting(latest.files); setReady(true)
      setError('Review the updated summary and confirm publication again.')
    } catch (cause) { setError(messageFrom(cause)) }
    finally { setLoading(false) }
  }

  async function publish() {
    if (busy || !ready || blockers.length || (create && !name.trim())) return
    setBusy(true); setProgress(0); setUploaded(false); setError(null)
    uploadedRef.current = false
    const abort = new AbortController()
    controller.current = abort
    try {
      const session = await requestJson<Session>('/web/session')
      if (!session.authenticated) throw new ApiFailure('Sign in again, then retry. Your selection is still here.', 401)
      const result = await uploadMultipart<{ site: SiteView }>(create ? '/web/sites' : `/web/sites/${encodeURIComponent(site!.id)}/files`, {
        method: create ? 'POST' : 'PUT', csrfToken: session.csrfToken, body,
        maxBytes: settings.limits.maxMultipartBodyBytes, signal: abort.signal,
        onProgress: (percent) => {
          if (percent === 100) { uploadedRef.current = true; setUploaded(true) }
          setProgress(percent)
        },
        onUploaded: () => { uploadedRef.current = true; setUploaded(true) },
      })
      onPublished(result.site)
    } catch (cause) {
      setAuthExpired(isUnauthorized(cause))
      if (isVersionConflict(cause) && site) {
        setUncertain(false); setReady(false); setOperationId(crypto.randomUUID())
        try {
          const latest = await readSiteManifest(site.id)
          setSite(latest.site); setExisting(latest.files); setReady(true)
          setError('This site changed. Review the updated summary and confirm publication again.')
        } catch (reloadFailure) { setError(messageFrom(reloadFailure)) }
      } else {
        setUncertain(!(cause instanceof ApiFailure) || cause.status === 0 || cause.status >= 500 || cause.status === 429 || cause.status === 401)
        setError(messageFrom(cause))
      }
    } finally { setBusy(false); controller.current = null }
  }

  function cancelUpload() { if (!uploadedRef.current) controller.current?.abort() }

  return <dialog aria-label={create ? 'New site' : 'Publish files'} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-950/40"
    ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }} onCancel={(event) => { if (busy) { event.preventDefault(); cancelUpload() } else onClose() }}>
    <h2 className="text-lg font-semibold text-slate-950">{create ? 'New site' : 'Publish files'}</h2>
    {create ? <>
      <p className="mt-2 text-sm text-slate-600">Your new site is private. {settings.defaultExpiresInSeconds === null ? 'It never expires.' : `It expires after ${settings.defaultExpiresInSeconds / 86400} ${settings.defaultExpiresInSeconds === 86400 ? 'day' : 'days'}, using your expiration default.`}</p>
      <label className="mt-4 block text-sm font-medium text-slate-700">Site name<Input className="mt-1" value={name} maxLength={100} disabled={busy || uncertain} onChange={(event) => { setName(event.target.value); setOperationId(crypto.randomUUID()) }} /></label>
    </> : site?.visibility === 'public' && <p className="mt-2 text-sm text-amber-800">This site is public. Changes are visible to visitors immediately.</p>}
    <PublicationPicker onPick={choose} disabled={busy || uncertain} />
    {loading ? <p className="flex items-center gap-2 text-sm"><Spinner />Loading all site files…</p> : picked.length > 0 && <div className="mt-2 space-y-3">
      <p className="text-sm font-medium text-slate-800">{plan.files.filter((file) => file.change === 'new').length} new · {plan.files.filter((file) => file.change === 'overwrite').length} overwritten · {formatBytes(body.size)}</p>
      <ul aria-label="Publication files" className="max-h-52 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">{plan.files.map((file) => <li className="flex justify-between gap-3 px-3 py-2 text-xs" key={`${file.index}:${file.path}`}><span className="break-all font-mono">{file.path}</span><span>{file.change === 'new' ? 'New' : 'Overwrite'}</span></li>)}</ul>
      {plan.ignored.length > 0 && <div><h3 className="text-sm font-medium text-slate-700">Ignored files ({plan.ignored.length})</h3><ul className="mt-1 max-h-36 overflow-auto text-xs text-slate-600">{plan.ignored.map((file, index) => <li className="py-1" key={index}><span className="break-all font-mono">{file.path}</span> — {file.reason}</li>)}</ul></div>}
      {blockers.length > 0 && <ul role="alert" className="space-y-1 text-sm text-red-700">{blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
    </div>}
    {busy && <div className="mt-4"><progress aria-label="Upload progress" className="w-full" value={progress} max={100} /><p role="status" className="text-xs text-slate-500">{uploaded ? 'Publishing…' : `Uploading… ${progress}%`}</p></div>}
    {error && <div className="mt-4"><ErrorMessage>{error}</ErrorMessage></div>}
    {authExpired && <a href="/" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-blue-700 underline">Sign in in a new tab, then retry</a>}
    {uncertain && <p className="mt-2 text-xs text-slate-600">The result is uncertain. Retry this selection to recover the same publication.</p>}
    <div className="mt-5 flex gap-2">
      {!ready && !loading && <Button variant="secondary" onClick={() => void reload()}>Reload site files</Button>}
      <Button disabled={busy || !ready || blockers.length > 0 || (create && !name.trim())} onClick={() => void publish()}>{busy && <Spinner />}{uncertain ? 'Retry publication' : create ? 'Create site' : 'Publish files'}</Button>
      <Button variant="secondary" disabled={busy && uploaded} onClick={() => busy ? cancelUpload() : onClose()}>{busy ? 'Cancel' : 'Close'}</Button>
    </div>
  </dialog>
}
