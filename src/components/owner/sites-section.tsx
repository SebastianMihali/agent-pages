import {
  ArrowUpRight,
  FileCode2,
  KeyRound,
  ChevronRight,
  Globe2,
  LockKeyhole,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManifestEntry, SiteView, Visibility } from '../../server/sites'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import {
  formatBytes,
  formatDate,
  formatRelative,
  isUnauthorized,
  isVersionConflict,
  messageFrom,
  requestJson,
} from './api'
import type { BrowserSettings, FileListResponse, OwnerSettings, SiteListResponse } from './api'
import { ErrorMessage } from './error-message'
import { FileWorkspace } from './file-workspace'
import { PublicationDialog, PublicationPicker } from './publication-dialog'
import type { PickedFile } from './publication-dialog'
import { FileDeletionDialog } from './file-deletion-dialog'

export function SitesSection({ csrfToken, selectedSiteId, returnPath, onSelectSite, onUnauthorized, onDirtyChange, editorOpen, initialFile, onOpenEditor, onManageKeys }: {
  editorOpen: boolean
  initialFile?: string
  onOpenEditor: (siteId: string, path?: string) => void
  onManageKeys: () => void
  onDirtyChange: (dirty: boolean) => void
  csrfToken: string
  selectedSiteId?: string
  returnPath?: string
  onSelectSite: (siteId: string | undefined, replace?: boolean) => void
  onUnauthorized: () => void
}) {
  const listRequest = useRef(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [sites, setSites] = useState<SiteView[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [settings, setSettings] = useState<BrowserSettings | null>(null)
  const [creatingSite, setCreatingSite] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSites = useCallback(async (nextCursor?: string) => {
    const request = ++listRequest.current
    const appending = Boolean(nextCursor)
    if (appending) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''
      const result = await requestJson<SiteListResponse>(`/web/sites${query}`)
      if (request !== listRequest.current) return
      setSites((current) => appending ? [...current, ...result.sites] : result.sites)
      setCursor(result.cursor)
    } catch (cause) {
      if (request !== listRequest.current) return
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      if (request === listRequest.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [onUnauthorized])

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  useEffect(() => {
    requestJson<BrowserSettings>('/web/settings').then(setSettings).catch((cause: unknown) => {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    })
  }, [onUnauthorized])

  useEffect(() => {
    if (!selectedSiteId && sites[0]) onSelectSite(sites[0].id, true)
  }, [onSelectSite, selectedSiteId, sites])

  async function setDefaultExpiration(value: string) {
    setSavingSettings(true)
    setError(null)
    try {
      const defaultExpiresInSeconds = value === 'never' ? null : Number(value)
      const updated = await requestJson<OwnerSettings>('/web/settings', {
        method: 'POST', body: JSON.stringify({ csrfToken, defaultExpiresInSeconds }),
      })
      setSettings((current) => current ? { ...current, ...updated } : current)
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally { setSavingSettings(false) }
  }

  return (
    <section aria-label={editorOpen ? 'Site workspace' : undefined} aria-labelledby={editorOpen ? undefined : 'sites-heading'} className={editorOpen ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {!editorOpen && <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Workspace</p>
          <h1 id="sites-heading" className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">Your sites</h1>
          <p className="mt-2 text-sm text-slate-500">Manage content and access in one place.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {(loading || sites.length > 0 || selectedSiteId) && <Button disabled={!settings} onClick={() => setCreatingSite(true)}>New site</Button>}
          <label className="text-xs font-medium text-slate-600">
            <span className="mb-1.5 block">New sites expire after</span>
            <select
              aria-label="New sites expire after"
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
              disabled={!settings || savingSettings}
              onChange={(event) => void setDefaultExpiration(event.target.value)}
              value={settings?.defaultExpiresInSeconds === null ? 'never' : String(settings?.defaultExpiresInSeconds ?? '')}
            >
              <option value="86400">1 day</option>
              <option value="604800">7 days</option>
              <option value="2592000">30 days</option>
              <option value="never">Never</option>
            </select>
          </label>
          <Button aria-label="Refresh site list" onClick={() => void loadSites()} variant="secondary" size="icon">
            <RefreshCw aria-hidden="true" className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>}
      {notice && <p className="mb-5 text-sm text-slate-700" role="status">{notice}</p>}
      {error && <div className="mb-5"><ErrorMessage>{error}</ErrorMessage></div>}

      {!editorOpen && !loading && !error && sites.length === 0 && !selectedSiteId ? <EmptySites onManageKeys={onManageKeys} onNewSite={() => setCreatingSite(true)} canCreate={!!settings} /> :
      <div className={editorOpen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : `grid min-w-0 gap-5 ${sites.length === 0 ? '' : 'xl:grid-cols-[14rem_minmax(0,1fr)]'}`}>
        {!editorOpen && <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            {loading ? 'Loading…' : `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}${cursor ? ' loaded' : ''}`}
          </div>
          {loading ? (
            <div className="space-y-3 p-4" aria-label="Loading sites">
              {[0, 1, 2].map((item) => <div className="h-16 animate-pulse rounded-lg bg-slate-100" key={item} />)}
            </div>
          ) : sites.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">{error ? 'Sites could not be loaded. Use refresh to try again.' : 'No sites available.'}</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {sites.map((site) => (
                <button
                  aria-current={selectedSiteId === site.id ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 px-4 py-4 text-left transition-colors ${
                    selectedSiteId === site.id ? 'bg-slate-50' : 'hover:bg-slate-50/70'
                  }`}
                  key={site.id}
                  onClick={() => onSelectSite(site.id)}
                  type="button"
                >
                  <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${site.visibility === 'public' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>
                    {site.visibility === 'public'
                      ? <Globe2 aria-hidden="true" className="size-4" />
                      : <LockKeyhole aria-hidden="true" className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{site.name}</span>
                    <span className="mt-1 block text-xs text-slate-400">Updated {formatRelative(site.updatedAt)}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-slate-300" />
                </button>
              ))}
              {cursor && (
                <div className="p-3">
                  <Button className="w-full" disabled={loadingMore} onClick={() => void loadSites(cursor)} variant="ghost" size="small">
                    {loadingMore && <Spinner />}
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>}
        {selectedSiteId ? (
          <SiteDetail
            settings={settings}
            editorOpen={editorOpen}
            initialFile={initialFile}
            onOpenEditor={onOpenEditor}
            onBack={() => onSelectSite(selectedSiteId)}
            onDirtyChange={onDirtyChange}
            csrfToken={csrfToken}
            key={selectedSiteId}
            onChanged={() => loadSites()}
            onDeleted={() => {
              setSites((current) => current.filter((site) => site.id !== selectedSiteId))
              onSelectSite(undefined, true)
              setNotice('Site deleted.')
              void loadSites()
            }}
            onUnauthorized={onUnauthorized}
            returnPath={returnPath}
            siteId={selectedSiteId}
          />
        ) : sites.length > 0 ? (
          <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-500">
            Select a site to view details.
          </div>
        ) : null}
      </div>}
      {creatingSite && settings && <PublicationDialog settings={settings} onClose={() => setCreatingSite(false)} onPublished={(created) => {
        setCreatingSite(false)
        setSites((current) => [created, ...current])
        onSelectSite(created.id)
        setNotice('Site created.')
        void loadSites()
      }} />}
    </section>
  )
}

function EmptySites({ onManageKeys, onNewSite, canCreate }: { onManageKeys: () => void; onNewSite: () => void; canCreate: boolean }) {
  return <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 shadow-sm sm:px-10 sm:py-20">
    <div className="mx-auto max-w-lg text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600"><Globe2 aria-hidden="true" className="size-6" /></span>
      <h2 className="mt-6 text-xl font-semibold tracking-tight text-slate-950">No sites</h2>
      <p className="mt-3 text-sm leading-6 text-slate-600">Publish your first site from files or a folder, or with an agent using MCP or the REST API. It will appear here, ready to view, edit, and share.</p>
      <div className="mt-6 flex justify-center gap-2"><Button disabled={!canCreate} onClick={onNewSite}>New site</Button><Button variant="secondary" onClick={onManageKeys}><KeyRound aria-hidden="true" className="size-4" />Manage API keys</Button></div>
      <p className="mt-4 text-xs leading-5 text-slate-500">Already have a key? Connect your agent and ask it to publish a site.</p>
    </div>
    <div className="mx-auto mt-10 grid max-w-2xl gap-6 border-t border-slate-100 pt-7 sm:grid-cols-3">
      {[['Connect your agent', 'Use an API key with REST or MCP.'], ['Publish your files', 'Include an index.html to get started.'], ['Make it yours', 'New sites are private. Share when ready.']].map(([title, description]) => <div key={title}><h3 className="text-sm font-medium text-slate-800">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{description}</p></div>)}
    </div>
  </div>
}

function SiteDetail({ siteId, settings, csrfToken, returnPath, onChanged, onDeleted, onUnauthorized, onDirtyChange, editorOpen, initialFile, onOpenEditor, onBack }: {
  siteId: string
  settings: BrowserSettings | null
  editorOpen: boolean
  initialFile?: string
  onOpenEditor: (siteId: string, path?: string) => void
  onBack: () => void
  csrfToken: string
  returnPath?: string
  onChanged: () => Promise<void>
  onDeleted: () => void
  onDirtyChange: (dirty: boolean) => void
  onUnauthorized: () => void
}) {
  const [site, setSite] = useState<SiteView | null>(null)
  const [publication, setPublication] = useState<PickedFile[] | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const editorDirtyChanged = useCallback((dirty: boolean) => { setEditorDirty(dirty); onDirtyChange(dirty) }, [onDirtyChange])
  const [files, setFiles] = useState<ManifestEntry[]>([])
  const [fileCursor, setFileCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [changingVisibility, setChangingVisibility] = useState(false)
  const [changingExpiration, setChangingExpiration] = useState(false)
  const [editingExpiration, setEditingExpiration] = useState(false)
  const [expirationPreset, setExpirationPreset] = useState('604800')
  const [deleteCommand, setDeleteCommand] = useState<{ operationId: string; expectedVersion: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    setError(null)
    try {
      const nextSite = await requestJson<SiteView>(`/web/sites/${encodeURIComponent(siteId)}`)
      setSite(nextSite)
      if (nextSite.expiresAt && Date.parse(nextSite.expiresAt) <= Date.now()) {
        return
      }
      const manifest = await requestJson<FileListResponse>(`/web/sites/${encodeURIComponent(siteId)}/files?revisionId=${nextSite.revisionId}`)
      setSite(nextSite)
      setFiles(manifest.files)
      setFileCursor(manifest.cursor)
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      setLoading(false)
    }
  }, [onUnauthorized, siteId])

  useEffect(() => {
    setConfirmPublic(false)
    void loadDetail()
  }, [loadDetail])

  async function loadMoreFiles() {
    if (!fileCursor || !site) return
    setLoadingFiles(true)
    setError(null)
    try {
      const result = await requestJson<FileListResponse>(
        `/web/sites/${encodeURIComponent(siteId)}/files?cursor=${encodeURIComponent(fileCursor)}&revisionId=${encodeURIComponent(site.revisionId)}`,
      )
      setFiles((current) => [...current, ...result.files])
      setFileCursor(result.cursor)
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      setLoadingFiles(false)
    }
  }

  // A version conflict means newer state exists: reload it instead of overwriting.
  async function reportMutationFailure(cause: unknown) {
    if (isUnauthorized(cause)) return onUnauthorized()
    if (isVersionConflict(cause)) await Promise.all([loadDetail(), onChanged()])
    setError(messageFrom(cause))
  }

  async function setExpiration() {
    if (!site) return
    setChangingExpiration(true)
    setError(null)
    try {
      await requestJson(`/web/sites/${encodeURIComponent(site.id)}/expiration`, {
        method: 'POST', body: JSON.stringify({ csrfToken, operationId: crypto.randomUUID(), expectedVersion: site.version,
          expiresInSeconds: expirationPreset === 'never' ? null : Number(expirationPreset) }),
      })
      setEditingExpiration(false)
      await Promise.all([loadDetail(), onChanged()])
    } catch (cause) {
      await reportMutationFailure(cause)
    } finally { setChangingExpiration(false) }
  }

  async function setVisibility(visibility: Visibility) {
    if (!site) return
    setChangingVisibility(true)
    setError(null)
    try {
      await requestJson(`/web/sites/${encodeURIComponent(site.id)}/visibility`, {
        method: 'POST',
        body: JSON.stringify({
          csrfToken,
          operationId: crypto.randomUUID(),
          expectedVersion: site.version,
          visibility,
        }),
      })
      setConfirmPublic(false)
      await Promise.all([loadDetail(), onChanged()])
    } catch (cause) {
      await reportMutationFailure(cause)
    } finally {
      setChangingVisibility(false)
    }
  }

  async function deleteSite() {
    if (!site || !deleteCommand || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await requestJson(`/web/sites/${encodeURIComponent(site.id)}`, {
        method: 'DELETE', body: JSON.stringify({ csrfToken, ...deleteCommand }),
      })
      onDeleted()
    } catch (cause) {
      // Keep the same command after an ambiguous failure so a retry can replay its receipt.
      if (isVersionConflict(cause)) setDeleteCommand(null)
      await reportMutationFailure(cause)
    } finally { setDeleting(false) }
  }

  if (loading) return <DetailSkeleton />
  if (!site) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><ErrorMessage>{error ?? 'Site unavailable.'}</ErrorMessage></div>
  }

  const expired = !!site.expiresAt && Date.parse(site.expiresAt) <= Date.now()
  const refreshFiles = () => { void loadDetail(); void onChanged() }
  const publicationDialogs = <>
    {publication && settings && <PublicationDialog site={site} settings={settings} initialPicked={publication} onClose={() => setPublication(null)} onPublished={() => { setPublication(null); refreshFiles() }} />}
    {deletingPath && <FileDeletionDialog site={site} path={deletingPath} onClose={() => setDeletingPath(null)} onDeleted={() => { setDeletingPath(null); refreshFiles() }} onReload={refreshFiles} />}
  </>

  if (editorOpen) return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <FileWorkspace siteId={site.id} siteName={site.name} onBack={onBack} initialPath={initialFile} files={files} hasMore={!!fileCursor} loadingMore={loadingFiles}
      onLoadMore={() => void loadMoreFiles()} onSaved={refreshFiles} onDirtyChange={editorDirtyChanged}
      onDeleteFile={expired ? undefined : setDeletingPath} />
    {publicationDialogs}
    {error && <div className="mt-2 max-h-24 shrink-0 overflow-auto"><ErrorMessage>{error}</ErrorMessage></div>}
  </div>

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold tracking-[-0.025em] text-slate-950">{site.name}</h2>
              <Badge tone={site.visibility}>{site.visibility === 'public' ? 'Public' : 'Private'}</Badge>
            </div>
            <p className="mt-2 truncate font-mono text-xs text-slate-400">{site.url}</p>
          </div>
          <a
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-800 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
            href={returnPath
              ? `${site.openUrl}${site.openUrl.includes('?') ? '&' : '?'}returnPath=${encodeURIComponent(returnPath)}`
              : site.openUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open site
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </a>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5 sm:grid-cols-4">
          <Metric label="Version" value={`v${site.version}`} />
          <Metric label="Files" value={String(site.fileCount)} />
          <Metric label="Size" value={formatBytes(site.sizeBytes)} />
          <Metric label="Expires" value={site.expiresAt ? formatDate(site.expiresAt) : 'Never'}>
            <button className="text-xs font-medium text-blue-700 hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              disabled={editorDirty || deleting || deleteCommand !== null}
              onClick={() => { setExpirationPreset(site.expiresAt ? '604800' : 'never'); setEditingExpiration(true) }} type="button">
              Change expiration
            </button>
          </Metric>
        </dl>
        {editingExpiration && (
          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-end">
            <label className="text-xs font-medium text-slate-600">
              <span className="mb-1.5 block">Site expiration</span>
              <select aria-label="Site expiration" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                disabled={editorDirty || changingExpiration || deleting || deleteCommand !== null} onChange={(event) => setExpirationPreset(event.target.value)} value={expirationPreset}>
                <option value="86400">1 day</option>
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
                <option value="never">Never</option>
              </select>
            </label>
            <div className="flex gap-2">
              <Button disabled={editorDirty || changingExpiration || deleting || deleteCommand !== null} onClick={() => void setExpiration()} size="small">
                {changingExpiration && <Spinner />}
                Save expiration
              </Button>
              <Button disabled={editorDirty || changingExpiration || deleting || deleteCommand !== null} onClick={() => setEditingExpiration(false)} variant="ghost" size="small">Cancel</Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-100 bg-slate-50/70 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Visibility</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {site.visibility === 'private'
                ? "Only you can open this site's pages and assets."
                : 'Anyone with the link can view its pages and assets.'}
            </p>
          </div>
          {site.visibility === 'private' ? (
            <Button disabled={editorDirty || changingVisibility || deleting || deleteCommand !== null} onClick={() => setConfirmPublic(true)} variant="secondary" size="small">
              <Globe2 aria-hidden="true" className="size-3.5" />
              Make public
            </Button>
          ) : (
            <Button disabled={editorDirty || changingVisibility || deleting || deleteCommand !== null} onClick={() => void setVisibility('private')} variant="secondary" size="small">
              {changingVisibility ? <Spinner /> : <LockKeyhole aria-hidden="true" className="size-3.5" />}
              Make private
            </Button>
          )}
        </div>
        {confirmPublic && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4" role="alert">
            <p className="text-sm font-semibold text-amber-950">Make this site public?</p>
            <p className="mt-1 text-xs leading-5 text-amber-800">Anyone can view and download all files without signing in.</p>
            <div className="mt-3 flex gap-2">
              <Button disabled={editorDirty || changingVisibility || deleting || deleteCommand !== null} onClick={() => void setVisibility('public')} size="small">
                {changingVisibility && <Spinner />}
                Confirm public access
              </Button>
              <Button disabled={editorDirty || changingVisibility || deleting || deleteCommand !== null} onClick={() => setConfirmPublic(false)} variant="ghost" size="small">Cancel</Button>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900">Files</h3>
          <a
            className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
            download
            href={`/web/sites/${encodeURIComponent(site.id)}/export`}
          >
            Export ZIP
          </a>
        </div>
        {error && !deleteCommand && <div className="mt-4"><ErrorMessage>{error}</ErrorMessage></div>}
        {expired ? (
          <p className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">This site has expired. Its files are no longer available.</p>
        ) : <PublicationPicker disabled={!settings} onPick={setPublication}><section aria-label="Site files" className="mt-4 overflow-hidden rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-600">Open a file to view or edit it in the workspace.</p>
            <Button variant="secondary" size="small" onClick={() => onOpenEditor(site.id)}>Open file editor<ArrowUpRight aria-hidden="true" className="size-3.5" /></Button>
          </div>
          <div className="divide-y divide-slate-100">{files.map((file) => <div key={file.path} className="flex items-center"><button type="button" onClick={() => onOpenEditor(site.id, file.path)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-500">
            <FileCode2 aria-hidden="true" className="size-4 shrink-0 text-slate-400" /><span className="min-w-0 flex-1 break-all font-mono text-xs text-slate-800">{file.path}</span><span className="shrink-0 text-xs text-slate-500">{formatBytes(file.sizeBytes)}</span><ChevronRight aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
          </button><Button className="mr-2 shrink-0" variant="ghost" size="icon" aria-label={`Delete ${file.path}`} title={file.path === 'index.html' ? 'index.html is required and cannot be deleted.' : `Delete ${file.path}`} disabled={file.path === 'index.html'} onClick={() => setDeletingPath(file.path)}><Trash2 aria-hidden="true" className="size-4" /></Button></div>)}</div>
          {fileCursor && <div className="border-t border-slate-100 p-3"><Button variant="ghost" size="small" disabled={loadingFiles} onClick={() => void loadMoreFiles()}>{loadingFiles && <Spinner />}Load more files</Button></div>}
        </section><p className="mt-2 text-xs text-slate-500">index.html is required and cannot be deleted.</p></PublicationPicker>}
        {publicationDialogs}

      </div>
      <div className="border-t border-slate-100 p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-slate-900">Delete site</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">Permanently remove this site and all its files.</p>
        {deleteCommand ? (
          <dialog aria-label="Confirm site deletion"
            className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-lg border border-red-200 bg-red-50 p-5 shadow-xl backdrop:bg-slate-950/40"
            ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }}
            onCancel={(event) => {
              if (deleting) event.preventDefault()
              else setDeleteCommand(null)
            }}>

            <p className="break-words text-sm font-semibold text-red-950">Delete “{site.name}” permanently?</p>
            <p className="mt-1 text-xs leading-5 text-red-800">Its URL will stop working. This cannot be undone. Export a ZIP first if you need a copy.</p>
            {error && <div className="mt-3"><ErrorMessage>{error}</ErrorMessage></div>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={deleting} onClick={() => void deleteSite()} variant="danger" size="small">
                {deleting && <Spinner />}
                Delete permanently
              </Button>
              <Button autoFocus disabled={deleting} onClick={() => setDeleteCommand(null)} variant="ghost" size="small">Cancel deletion</Button>
            </div>
          </dialog>
        ) : (
          <Button className="mt-3" disabled={editorDirty || changingVisibility || changingExpiration} onClick={() => {
            setConfirmPublic(false)
            setEditingExpiration(false)
            setDeleteCommand({ operationId: crypto.randomUUID(), expectedVersion: site.version })
          }} variant="danger" size="small">
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete site
          </Button>
        )}
      </div>
    </article>
  )
}

function DetailSkeleton() {
  return (
    <div aria-label="Loading site details" className="min-h-[34rem] animate-pulse rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="h-7 w-52 rounded bg-slate-100" />
      <div className="mt-3 h-4 w-72 max-w-full rounded bg-slate-100" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div className="h-12 rounded bg-slate-100" key={item} />)}
      </div>
      <div className="mt-10 h-56 rounded-lg bg-slate-100" />
    </div>
  )
}

function Metric({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">{value}{children}</dd>
    </div>
  )
}
