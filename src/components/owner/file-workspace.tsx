import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ManifestEntry, SiteFileView, FileMutationResult } from '../../server/sites'
import { ArrowUpRight, ArrowLeft, ChevronRight, Columns2, X, Info, Check, Copy, Download, FileCode2, Pencil, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { isRasterImage } from '../../shared/site-file'
import { Button } from '../ui/button'
import { IconButton, Tooltip } from '../ui/icon-button'
import { Spinner } from '../ui/spinner'
import { Input } from '../ui/input'
import { ApiFailure, formatBytes, isUnauthorized, isVersionConflict, messageFrom, requestJson } from './api'
import type { Session } from './api'
import type { EditorSession } from './code-editor'
import { ErrorMessage } from './error-message'

const CodeEditor = lazy(() => import('./code-editor'))
type Draft = {
  snapshot: SiteFileView; content: string; session: EditorSession; editing: boolean
  operationId?: string; conflict?: SiteFileView; notice?: string
}

export function FileWorkspace({ siteId, files, hasMore, loadingMore, onLoadMore, onSaved, onDirtyChange, initialPath, siteName, onBack, onDeleteFile }: {
  siteName: string
  onDeleteFile?: (path: string) => void
  onBack: () => void
  initialPath?: string
  siteId: string; files: ManifestEntry[]; hasMore: boolean; loadingMore: boolean
  onLoadMore: () => void; onSaved: () => void; onDirtyChange: (dirty: boolean) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [compare, setCompare] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const request = useRef(0)
  const draft = selected ? drafts[selected] : undefined
  const dirty = Object.values(drafts).some((entry) => entry.content !== (entry.snapshot.content ?? '') || !!entry.operationId)
  const changed = draft && draft.content !== (draft.snapshot.content ?? '')
  const fileUrl = (path: string, mode?: string) => `/web/sites/${siteId}/file?${new URLSearchParams({ path, ...(mode ? { mode } : {}) })}`

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => { request.current++; onDirtyChange(false) }, [onDirtyChange])

  function update(path: string, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [path]: { ...current[path], ...change } }))
  }

  async function openFile(path: string, force = false) {
    if (busy) return
    const generation = ++request.current
    setSelected(path)
    setCompare(false)
    setError(null)
    if (!force && drafts[path]) { setLoading(false); return }
    setLoading(true)
    try {
      const snapshot = await requestJson<SiteFileView>(fileUrl(path))
      if (generation !== request.current) return
      // Keep at most 20 documents in memory. Dirty drafts are never silently evicted.
      setDrafts((current) => {
        const entries = Object.entries(current)
        if (!current[path] && entries.length >= 20) {
          const evict = entries.find(([, entry]) => !entry.operationId && entry.content === (entry.snapshot.content ?? ''))
          if (!evict) return current
          current = { ...current }; delete current[evict[0]]
        }
        return { ...current, [path]: { snapshot, content: snapshot.content ?? '', session: {}, editing: false } }
      })
      setAuthExpired(false)
    } catch (cause) {
      if (generation !== request.current) return
      setAuthExpired(isUnauthorized(cause))
      setError(messageFrom(cause))
    } finally { if (generation === request.current) setLoading(false) }
  }

  useEffect(() => {
    if (!initialPath) return
    void openFile(initialPath)
    // StrictMode replays effects after cleanup: restart the initial read too.
    // Only the initial path is a dependency; switching files retains local drafts.
  }, [initialPath])

  async function save() {
    if (!draft || !selected || busy || draft.conflict) return
    const path = selected
    const operationId = draft.operationId ?? crypto.randomUUID()
    update(path, { operationId, notice: undefined })
    setBusy(true); setError(null)
    try {
      // A login in another tab can renew the session without destroying drafts.
      const session = await requestJson<Session>('/web/session')
      if (!session.authenticated) throw new ApiFailure('Sign in again to save. Your draft is still here.', 401)
      const result = await requestJson<FileMutationResult>(`/web/sites/${siteId}/file`, { method: 'PUT', body: JSON.stringify({
        csrfToken: session.csrfToken, path, content: draft.content, operationId, expectedVersion: draft.snapshot.site.version,
      }) })
      update(path, { snapshot: { ...draft.snapshot, site: result.site, content: draft.content,
        file: { ...draft.snapshot.file, sizeBytes: new TextEncoder().encode(draft.content).byteLength } },
      operationId: undefined, editing: false, notice: 'Changes saved.', conflict: undefined })
      setCompare(false); setAuthExpired(false)
      onSaved()
    } catch (cause) {
      setAuthExpired(isUnauthorized(cause))
      if (isVersionConflict(cause)) {
        // Never substitute a newer version and silently overwrite the agent's work.
        update(path, { operationId: undefined })
        try {
          const latest = await requestJson<SiteFileView>(fileUrl(path))
          update(path, { conflict: latest })
          setCompare(true)
          setError('This site changed after you opened the file. Review the current content before saving your draft.')
        } catch {
          setError('This site changed and its current file could not be loaded. Your draft is preserved. Retry to check again.')
        }
      } else {
        // Preserve the operation and freeze editing after uncertain delivery.
        if (cause instanceof ApiFailure && cause.status < 500 && cause.status !== 429 && (!draft.operationId || cause.status !== 401)) update(path, { operationId: undefined })
        setError(messageFrom(cause))
      }
    } finally { setBusy(false) }
  }

  async function copy() {
    if (!draft || !selected) return
    try { await navigator.clipboard.writeText(draft.content); update(selected, { notice: 'Copied to clipboard.' }) }
    catch { setError('Clipboard access is unavailable. Select the text in the editor to copy it.') }
  }

  // Refreshing the manifest must not strand a draft whose path was removed by an agent.
  const listedPaths = new Set(files.map((file) => file.path))
  const availableFiles = [...files, ...Object.values(drafts).filter((entry) => !listedPaths.has(entry.snapshot.file.path)).map((entry) => entry.snapshot.file)]
  const filtered = availableFiles.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
  const pending = busy || !!draft?.operationId
  return <section aria-label="File workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <nav aria-label="Breadcrumb" className="mb-3 flex min-w-0 shrink-0 items-center gap-2 text-sm text-slate-600">
      <IconButton label="Back to site" variant="ghost" onClick={onBack}><ArrowLeft aria-hidden="true" className="size-4" /></IconButton>
      <span className="min-w-0 max-w-[45%] truncate" title={siteName}>{siteName}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-slate-400" />
      <span aria-current="page" className="min-w-0 truncate font-mono text-xs text-slate-900" title={selected ?? 'Files'}>{selected ?? 'Files'}</span>
    </nav>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 xl:flex-row">
      <div className="flex min-h-0 min-w-0 shrink-0 flex-col border-b border-slate-200 bg-slate-50/70 xl:w-56 xl:border-r xl:border-b-0">
        <div className="flex shrink-0 items-center gap-2 p-2 xl:block xl:p-3">
          <label className="relative block min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <Input aria-label="Filter loaded files" className="h-9 pl-9 text-xs" onChange={(event) => setFilter(event.target.value)} placeholder="Find a file…" value={filter} />
          </label>
          {hasMore && <p className="mt-2 text-[11px] text-slate-500">Searching loaded files only.</p>}
          <select aria-label="Choose file" className="h-9 w-1/2 min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm xl:hidden" value={selected ?? ''} disabled={busy}
            onChange={(event) => void openFile(event.target.value)}>
            <option value="" disabled>Select a file</option>
            {filtered.map((file) => <option key={file.path} value={file.path}>{file.path}{drafts[file.path]?.content !== undefined && drafts[file.path].content !== (drafts[file.path].snapshot.content ?? '') ? ' •' : ''}</option>)}
          </select>
        </div>
        <div className="hidden min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pt-0 xl:block">
          {filtered.map((file) => <button key={file.path} disabled={busy} type="button" aria-pressed={selected === file.path}
            className={`mb-1 flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-slate-500 ${selected === file.path ? 'bg-white text-slate-950 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white'}`}
            onClick={() => void openFile(file.path)}>
            <FileCode2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1"><span className="block break-all font-mono text-xs">{file.path}</span><span className="mt-1 block text-[11px] text-slate-500">{formatBytes(file.sizeBytes)}</span></span>
            {drafts[file.path] && drafts[file.path].content !== (drafts[file.path].snapshot.content ?? '') && <span aria-label="Unsaved changes" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />}
          </button>)}
          {!filtered.length && <p className="p-2 text-xs text-slate-500">No matching files.</p>}
        </div>
        {hasMore && <div className="p-3 pt-0"><Button className="w-full" variant="secondary" size="small" disabled={loadingMore || busy} onClick={onLoadMore}>{loadingMore && <Spinner />}Load more files</Button></div>}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
        {loading ? <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Spinner />Loading file…</div> : draft && selected ? <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <p className="min-w-0 truncate text-xs text-slate-500" title={draft.snapshot.file.contentType}>{formatBytes(draft.snapshot.file.sizeBytes)}<span className="hidden sm:inline"> · {draft.snapshot.file.contentType}</span></p>
            <div className="flex flex-wrap gap-1">
              {draft.snapshot.content !== null && <IconButton label="Copy file content" variant="ghost" onClick={() => void copy()}><Copy aria-hidden="true" className="size-4" /></IconButton>}
              <Tooltip label="Download file"><a aria-label="Download file" className="file-action" download href={fileUrl(selected, 'download')}><Download aria-hidden="true" className="size-4" /></a></Tooltip>
              {/\.html?$/i.test(selected) && <Tooltip label="Open page"><a className="file-action" aria-label="Open page" target="_blank" rel="noopener noreferrer"
                href={`${draft.snapshot.site.openUrl}?returnPath=${encodeURIComponent('/' + selected.split('/').map(encodeURIComponent).join('/'))}`}><ArrowUpRight aria-hidden="true" className="size-4" /></a></Tooltip>}
              {onDeleteFile && <IconButton label={selected === 'index.html' ? 'index.html is required and cannot be deleted.' : `Delete ${selected}`} variant="ghost" disabled={selected === 'index.html' || pending} onClick={() => onDeleteFile(selected)}><Trash2 aria-hidden="true" className="size-4" /></IconButton>}
              <IconButton label="Reload file" variant="ghost" disabled={pending} onClick={() => changed ? setConfirmDiscard(true) : void openFile(selected, true)}><RefreshCw aria-hidden="true" className="size-4" /></IconButton>
            </div>
          </div>
          {draft.snapshot.content !== null ? <>
            <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Spinner />Loading editor…</div>}>
              <CodeEditor key={selected} path={selected} content={draft.content} original={draft.conflict?.content ?? draft.snapshot.content}
                session={draft.session} readOnly={!draft.editing || pending} compare={compare}
                onChange={(content) => update(selected, { content, notice: undefined })} />
            </Suspense>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-3 py-2">
              <p className="min-w-0 truncate text-xs text-slate-500" role="status">{busy ? 'Saving…' : draft.notice ?? (changed ? 'Unsaved changes' : 'All changes saved')}
                {draft.notice === 'Changes saved.' && <Check aria-hidden="true" className="ml-1 inline size-3.5 text-emerald-600" />}</p>
              <div className="flex shrink-0 gap-1">
                <IconButton label={`Saving publishes immediately. Limit: ${formatBytes(draft.snapshot.maxEditableBytes)}.`} variant="ghost"><Info aria-hidden="true" className="size-4" /></IconButton>
                {draft.editing ? <>
                  <IconButton label="Compare" variant="ghost" aria-pressed={compare} onClick={() => setCompare(!compare)}><Columns2 aria-hidden="true" className="size-4" /></IconButton>
                  <IconButton label="Discard" variant="ghost" disabled={pending} onClick={() => changed ? setConfirmDiscard(true) : update(selected, { editing: false })}><X aria-hidden="true" className="size-4" /></IconButton>
                  <Button className="h-9" disabled={busy || (!changed && !draft.operationId) || !!draft.conflict || new TextEncoder().encode(draft.content).byteLength > draft.snapshot.maxEditableBytes} onClick={() => void save()}>
                    {busy ? <Spinner /> : <Save aria-hidden="true" className="size-4" />}
                    {busy ? 'Saving…' : draft.operationId ? 'Retry save' : 'Save changes'}
                  </Button>
                </> : <Button className="h-9" variant="secondary" onClick={() => update(selected, { editing: true, notice: undefined })}><Pencil aria-hidden="true" className="size-4" />Edit file</Button>}
              </div>
            </div>

            {new TextEncoder().encode(draft.content).byteLength > draft.snapshot.maxEditableBytes && <p role="alert" className="max-h-20 shrink-0 overflow-auto px-4 py-2 text-xs text-red-700">This draft exceeds the editor size limit. Shorten it before saving.</p>}
          </> : <div className="min-h-0 flex-1 overflow-auto p-6">
            {isRasterImage(selected) && <img alt={`Preview of ${selected}`} src={fileUrl(selected, 'preview')} className="mx-auto mb-5 max-h-80 max-w-full rounded object-contain" />}
            <p className="text-sm leading-6 text-slate-500">{draft.snapshot.unavailableReason}</p>
          </div>}
          {draft.conflict && <div className="max-h-[35%] shrink-0 overflow-auto border-t border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-950">Your draft is safe</p>
            <p className="mt-1 text-xs leading-5 text-amber-900">Compare shows your draft against the current saved file. Review both before choosing which content to keep.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {draft.conflict.content !== null && <Button variant="secondary" size="small" onClick={() => {
                update(selected, { snapshot: draft.conflict!, conflict: undefined, notice: 'Current content reviewed. Save to publish your draft.' })
                setError(null)
              }}>Keep my draft</Button>}
              <Button variant="ghost" size="small" onClick={() => setConfirmDiscard(true)}>Use current file</Button>
            </div>
          </div>}
        </> : <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4 text-center"><div><FileCode2 aria-hidden="true" className="mx-auto mb-3 size-7 text-slate-300" /><p className="text-sm font-medium text-slate-700">Select a file to get started</p><p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">Read source, preview images, or make a quick edit.</p>{Object.keys(drafts).length >= 20 && <p className="mt-3 text-xs text-amber-700">Save or discard an open draft before opening more files.</p>}</div></div>}
        {error && <div className="max-h-[30%] shrink-0 overflow-auto border-t border-slate-100 p-3"><ErrorMessage>{error}</ErrorMessage>
          {authExpired && <a className="mt-2 inline-block text-sm font-medium text-blue-700 underline" href="/" target="_blank" rel="noopener noreferrer">Sign in in a new tab, then retry</a>}
        </div>}
      </div>
    </div>
    {confirmDiscard && selected && <dialog aria-label="Discard file changes" className="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-950/40"
      ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }} onCancel={() => setConfirmDiscard(false)}>
      <h3 className="text-lg font-semibold text-slate-950">Discard your changes?</h3><p className="mt-2 text-sm leading-6 text-slate-500">The current saved file will be loaded. Your unsaved edits to this file will be lost.</p>
      <div className="mt-5 flex gap-2"><Button variant="danger" onClick={() => {
        setConfirmDiscard(false)
        setDrafts((current) => { const next = { ...current }; delete next[selected]; return next })
        void openFile(selected, true)
      }}>Discard changes</Button><Button autoFocus variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep editing</Button></div>
    </dialog>}
  </section>
}
