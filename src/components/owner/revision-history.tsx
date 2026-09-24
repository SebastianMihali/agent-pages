import { useCallback, useEffect, useRef, useState } from 'react'
import type { SiteView, ManifestEntry } from '../../server/sites'
import { isRasterImage } from '../../shared/site-file'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { ApiFailure, formatBytes, formatDate, isUnauthorized, isVersionConflict, messageFrom, requestJson } from './api'
import type { FileListResponse, RevisionListResponse, RevisionSummary, Session } from './api'
import { ErrorMessage } from './error-message'

type RestoreCommand = { operationId: string; expectedVersion: number; revisionId: string; publishedVersion: number | null }

export function RevisionHistory({ site, dirty, onRestored, onUnauthorized }: {
  site: SiteView
  dirty: boolean
  onRestored: () => Promise<void>
  onUnauthorized: () => void
}) {
  const requestId = useRef(0)
  const fileRequestId = useRef(0)
  const selectedRef = useRef<string | null>(null)
  const [history, setHistory] = useState<RevisionListResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<ManifestEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [command, setCommand] = useState<RestoreCommand | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const base = `/web/sites/${encodeURIComponent(site.id)}`

  const loadHistory = useCallback(async (): Promise<boolean | null> => {
    const request = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const next = await requestJson<RevisionListResponse>(`${base}/revisions`)
      if (request !== requestId.current) return null
      setHistory(next)
      if (selectedRef.current && !next.revisions.some((revision) => revision.revisionId === selectedRef.current)) {
        selectedRef.current = null
        fileRequestId.current++
        setSelected(null)
      }
      return true
    } catch (cause) {
      if (request !== requestId.current) return null
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
      return false
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [base, onUnauthorized])

  useEffect(() => {
    void loadHistory()
    return () => { requestId.current++ }
  }, [loadHistory, site.version])

  useEffect(() => {
    if (!selected) { setFiles([]); setCursor(null); return }
    const fileRequest = ++fileRequestId.current
    let cancelled = false
    setFiles([]); setCursor(null); setFileError(null); setLoadingFiles(true)
    void requestJson<FileListResponse>(`${base}/files?${new URLSearchParams({ revisionId: selected })}`)
      .then((page) => { if (!cancelled && fileRequest === fileRequestId.current && page.revisionId === selectedRef.current) { setFiles(page.files); setCursor(page.cursor) } })
      .catch((cause) => { if (!cancelled && fileRequest === fileRequestId.current) { if (isUnauthorized(cause)) onUnauthorized(); else setFileError(messageFrom(cause)) } })
      .finally(() => { if (!cancelled && fileRequest === fileRequestId.current) setLoadingFiles(false) })
    return () => { cancelled = true }
  }, [base, selected, onUnauthorized])

  async function loadMore() {
    if (!selected || !cursor || loadingFiles) return
    const fileRequest = fileRequestId.current
    const revisionId = selected
    setLoadingFiles(true); setFileError(null)
    try {
      const page = await requestJson<FileListResponse>(`${base}/files?${new URLSearchParams({ revisionId, cursor })}`)
      if (fileRequest !== fileRequestId.current || selectedRef.current !== revisionId || page.revisionId !== revisionId) return
      setFiles((current) => [...current, ...page.files]); setCursor(page.cursor)
    } catch (cause) {
      if (fileRequest !== fileRequestId.current || selectedRef.current !== revisionId) return
      if (isUnauthorized(cause)) onUnauthorized()
      else setFileError(messageFrom(cause))
    } finally { if (fileRequest === fileRequestId.current) setLoadingFiles(false) }
  }

  function chooseRevision(revisionId: string) {
    if (selectedRef.current === revisionId) return
    selectedRef.current = revisionId
    fileRequestId.current++
    setFiles([]); setCursor(null); setFileError(null)
    setSelected(revisionId)
  }

  async function restore() {
    if (!command || restoring || dirty) return
    setRestoring(true); setRestoreError(null); setAuthExpired(false)
    try {
      // A fresh session also supplies a fresh CSRF token after signing in elsewhere.
      const session = await requestJson<Session>('/web/session')
      if (!session.authenticated) throw new ApiFailure('Sign in again, then retry restore.', 401)
      await requestJson(`${base}/restore`, { method: 'POST', body: JSON.stringify({ csrfToken: session.csrfToken,
        operationId: command.operationId, expectedVersion: command.expectedVersion, revisionId: command.revisionId }) })
    } catch (cause) {
      setAuthExpired(isUnauthorized(cause))
      if (isVersionConflict(cause) || (cause instanceof ApiFailure && cause.code === 'REVISION_UNAVAILABLE')) {
        setCommand(null)
        setHistory(null)
        const [siteRefresh, historyRefresh] = await Promise.allSettled([onRestored(), loadHistory()])
        setError(isVersionConflict(cause)
          ? 'This site changed. Review its current version and confirm restore again.'
          : 'That revision is no longer available. Review the refreshed history.')
        if (siteRefresh.status === 'rejected' || historyRefresh.status === 'rejected' || (historyRefresh.status === 'fulfilled' && historyRefresh.value === false)) {
          setError('The site changed, but its current state could not be loaded. Refresh history before confirming another restore.')
        }
      } else setRestoreError(messageFrom(cause))
      setRestoring(false)
      return
    } finally { setRestoring(false) }
    setCommand(null)
    setHistory(null)
    const [siteRefresh, historyRefresh] = await Promise.allSettled([onRestored(), loadHistory()])
    if (siteRefresh.status === 'rejected' || historyRefresh.status === 'rejected' || (historyRefresh.status === 'fulfilled' && historyRefresh.value === false)) {
      setError('Restore completed, but current details could not be loaded. Refresh history to see the latest state.')
    }
  }

  const chosen = history?.revisions.find((revision) => revision.revisionId === selected)
  return <section aria-label="Revision history" className="border-t border-slate-100 p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-slate-900">Revision history</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">Restore a retained version of the files. Site visibility and expiration stay as they are.</p></div>
      <Button variant="secondary" size="small" disabled={loading} onClick={() => void loadHistory()}>{loading && <Spinner />}Refresh history</Button>
    </div>
    {error && <div className="mt-4"><ErrorMessage>{error}</ErrorMessage></div>}
    {history && <p className="mt-3 text-xs text-slate-500">{history.revisions.length} retained {history.revisions.length === 1 ? 'revision' : 'revisions'} · limit {history.historyLimit + 1} including current</p>}
    {loading && !history ? <p className="mt-4 text-sm text-slate-500">Loading history…</p> : history && <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]">
      <div className="max-h-96 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {history.revisions.map((revision) => <RevisionRow key={revision.revisionId} revision={revision} selected={selected === revision.revisionId} onClick={() => chooseRevision(revision.revisionId)} />)}
      </div>
      <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-4">
        {chosen ? <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-sm font-semibold text-slate-900">{chosen.active ? 'Current files' : `Files from v${chosen.publishedVersion ?? '?'}`}</p>
              <p className="mt-1 text-xs text-slate-500">{chosen.fileCount} files · {formatBytes(chosen.sizeBytes)}</p></div>
            {!chosen.active && <Button size="small" disabled={dirty || loading || !!command} onClick={() => { setRestoreError(null); setError(null); setCommand({ operationId: crypto.randomUUID(), expectedVersion: history.site.version, revisionId: chosen.revisionId, publishedVersion: chosen.publishedVersion }) }}>Restore this revision</Button>}
          </div>
          {dirty && !chosen.active && <p className="mt-3 text-xs text-amber-800">Save or discard your editor draft before restoring.</p>}
          {fileError && <div className="mt-3"><ErrorMessage>{fileError}</ErrorMessage></div>}
          <div className="mt-3 max-h-72 divide-y divide-slate-200 overflow-auto rounded border border-slate-200 bg-white">
            {files.map((file) => {
              const url = `${base}/file?${new URLSearchParams({ path: file.path, revisionId: chosen.revisionId, mode: 'download' })}`
              const preview = `${base}/file?${new URLSearchParams({ path: file.path, revisionId: chosen.revisionId, mode: 'preview' })}`
              return <div className="flex min-w-0 flex-wrap items-center gap-2 p-2 text-xs" key={file.path}>
                <span className="min-w-0 flex-1 break-all font-mono text-slate-800">{file.path}</span>
                <span className="text-slate-500">{formatBytes(file.sizeBytes)}</span>
                {isRasterImage(file.path) && <a className="font-medium text-blue-700 underline" href={preview} target="_blank" rel="noopener noreferrer">Preview</a>}
                <a className="font-medium text-blue-700 underline" download href={url}>Download</a>
              </div>
            })}
            {loadingFiles && <p className="p-3 text-xs text-slate-500">Loading files…</p>}
          </div>
          {cursor && <Button className="mt-3" variant="secondary" size="small" disabled={loadingFiles} onClick={() => void loadMore()}>{loadingFiles && <Spinner />}Load more files</Button>}
        </> : <p className="text-sm text-slate-500">Select a revision to inspect its files.</p>}
      </div>
    </div>}
    {command && <dialog aria-label="Confirm revision restore" className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-950/40"
      ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }} onCancel={(event) => { if (restoring) event.preventDefault(); else setCommand(null) }}>
      <h3 className="text-lg font-semibold text-slate-950">Restore revision?</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">Publish the files from {command.publishedVersion === null ? 'an earlier revision' : `v${command.publishedVersion}`} ({command.revisionId.slice(0, 8)}) as the current version of “{site.name}”? Visitors will see these files immediately if the site is public.</p>
      {dirty && <p className="mt-3 text-sm text-amber-800">Save or discard your editor draft before restoring.</p>}
      {restoreError && <div className="mt-3"><ErrorMessage>{restoreError}</ErrorMessage></div>}
      {restoreError && !authExpired && <p className="mt-2 text-xs text-slate-600">Retry this same restore to check whether it completed.</p>}
      {authExpired && <a href="/" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-blue-700 underline">Sign in in a new tab, then retry</a>}
      <div className="mt-5 flex flex-wrap gap-2"><Button disabled={restoring || dirty} onClick={() => void restore()}>{restoring && <Spinner />}Confirm restore</Button><Button autoFocus variant="secondary" disabled={restoring} onClick={() => setCommand(null)}>Cancel</Button></div>
    </dialog>}
  </section>
}

function RevisionRow({ revision, selected, onClick }: { revision: RevisionSummary; selected: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onClick} className={`block w-full p-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-500 ${selected ? 'bg-slate-50' : 'bg-white'}`}>
    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">{revision.publishedVersion === null ? 'Earlier revision' : `v${revision.publishedVersion}`} {revision.active && <Badge tone="private">Current</Badge>}</span>
    <span className="mt-1 block font-mono text-[11px] text-slate-400" title={revision.revisionId}>{revision.revisionId.slice(0, 8)}</span>
    <span className="mt-1 block text-xs text-slate-500">Published {formatDate(revision.createdAt)} · {revision.fileCount} files · {formatBytes(revision.sizeBytes)}</span>
    {revision.lastActivatedVersion !== null && <span className="mt-1 block text-xs text-slate-500">Last active at v{revision.lastActivatedVersion}{revision.lastActivatedAt ? ` · ${formatDate(revision.lastActivatedAt)}` : ''}</span>}
  </button>
}
