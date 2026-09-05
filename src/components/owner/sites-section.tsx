import {
  ArrowUpRight,
  ChevronRight,
  FileCode2,
  Globe2,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ManifestEntry, SiteView, Visibility } from '../../server/sites'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import {
  formatBytes,
  formatDate,
  formatRelative,
  isUnauthorized,
  messageFrom,
  requestJson,
} from './api'
import type { FileListResponse, SiteListResponse } from './api'
import { ErrorMessage } from './error-message'

export function SitesSection({ csrfToken, selectedSiteId, returnPath, onSelectSite, onUnauthorized }: {
  csrfToken: string
  selectedSiteId?: string
  returnPath?: string
  onSelectSite: (siteId: string, replace?: boolean) => void
  onUnauthorized: () => void
}) {
  const [sites, setSites] = useState<SiteView[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSites = useCallback(async (nextCursor?: string) => {
    const appending = Boolean(nextCursor)
    if (appending) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const query = nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''
      const result = await requestJson<SiteListResponse>(`/web/sites${query}`)
      setSites((current) => appending ? [...current, ...result.sites] : result.sites)
      setCursor(result.cursor)
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void loadSites()
  }, [loadSites])

  useEffect(() => {
    if (!selectedSiteId && sites[0]) onSelectSite(sites[0].id, true)
  }, [onSelectSite, selectedSiteId, sites])

  return (
    <section aria-labelledby="sites-heading">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Workspace</p>
          <h1 id="sites-heading" className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">I tuoi siti</h1>
          <p className="mt-2 text-sm text-slate-500">Controlla contenuti e accesso da un unico spazio.</p>
        </div>
        <Button aria-label="Aggiorna elenco siti" onClick={() => void loadSites()} variant="secondary" size="icon">
          <RefreshCw aria-hidden="true" className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {error && <div className="mb-5"><ErrorMessage>{error}</ErrorMessage></div>}

      <div className="grid min-w-0 gap-5 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            {loading ? 'Caricamento…' : `${sites.length} ${sites.length === 1 ? 'sito' : 'siti'}`}
          </div>
          {loading ? (
            <div className="space-y-3 p-4" aria-label="Caricamento siti">
              {[0, 1, 2].map((item) => <div className="h-16 animate-pulse rounded-lg bg-slate-100" key={item} />)}
            </div>
          ) : sites.length === 0 ? (
            <EmptySites />
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
                    <span className="mt-1 block text-xs text-slate-400">Aggiornato {formatRelative(site.updatedAt)}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-slate-300" />
                </button>
              ))}
              {cursor && (
                <div className="p-3">
                  <Button className="w-full" disabled={loadingMore} onClick={() => void loadSites(cursor)} variant="ghost" size="small">
                    {loadingMore && <Spinner />}
                    Carica altri
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {selectedSiteId ? (
          <SiteDetail
            csrfToken={csrfToken}
            key={selectedSiteId}
            onChanged={() => loadSites()}
            onUnauthorized={onUnauthorized}
            returnPath={returnPath}
            siteId={selectedSiteId}
          />
        ) : (
          <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-500">
            Seleziona un sito per vedere i dettagli.
          </div>
        )}
      </div>
    </section>
  )
}

function EmptySites() {
  return (
    <div className="px-6 py-12 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-500">
        <Globe2 aria-hidden="true" className="size-5" />
      </span>
      <p className="mt-4 text-sm font-medium text-slate-800">Nessun sito</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">Crea il primo sito tramite REST o MCP.</p>
    </div>
  )
}

function SiteDetail({ siteId, csrfToken, returnPath, onChanged, onUnauthorized }: {
  siteId: string
  csrfToken: string
  returnPath?: string
  onChanged: () => Promise<void>
  onUnauthorized: () => void
}) {
  const [site, setSite] = useState<SiteView | null>(null)
  const [files, setFiles] = useState<ManifestEntry[]>([])
  const [fileCursor, setFileCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [changingVisibility, setChangingVisibility] = useState(false)
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    setFiles([])
    setFileCursor(null)
    try {
      const [nextSite, manifest] = await Promise.all([
        requestJson<SiteView>(`/web/sites/${encodeURIComponent(siteId)}`),
        requestJson<FileListResponse>(`/web/sites/${encodeURIComponent(siteId)}/files`),
      ])
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
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      setChangingVisibility(false)
    }
  }

  if (loading) return <DetailSkeleton />
  if (!site) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><ErrorMessage>{error ?? 'Sito non disponibile.'}</ErrorMessage></div>
  }

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold tracking-[-0.025em] text-slate-950">{site.name}</h2>
              <Badge tone={site.visibility}>{site.visibility === 'public' ? 'Pubblico' : 'Privato'}</Badge>
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
            Apri sito
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </a>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-slate-100 pt-5 sm:grid-cols-4">
          <Metric label="Versione" value={`v${site.version}`} />
          <Metric label="File" value={String(site.fileCount)} />
          <Metric label="Dimensione" value={formatBytes(site.sizeBytes)} />
          <Metric label="Scadenza" value={site.expiresAt ? formatDate(site.expiresAt) : 'Nessuna'} />
        </dl>
      </div>

      <div className="border-b border-slate-100 bg-slate-50/70 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Visibilità</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {site.visibility === 'private'
                ? 'Solo tu puoi aprire pagine e risorse di questo sito.'
                : 'Chiunque abbia il link può vedere pagine e risorse.'}
            </p>
          </div>
          {site.visibility === 'private' ? (
            <Button disabled={changingVisibility} onClick={() => setConfirmPublic(true)} variant="secondary" size="small">
              <Globe2 aria-hidden="true" className="size-3.5" />
              Rendi pubblico
            </Button>
          ) : (
            <Button disabled={changingVisibility} onClick={() => void setVisibility('private')} variant="secondary" size="small">
              {changingVisibility ? <Spinner /> : <LockKeyhole aria-hidden="true" className="size-3.5" />}
              Rendi privato
            </Button>
          )}
        </div>
        {confirmPublic && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4" role="alert">
            <p className="text-sm font-semibold text-amber-950">Rendere pubblico questo sito?</p>
            <p className="mt-1 text-xs leading-5 text-amber-800">Chiunque potrà vedere e scaricare tutti i file, senza autenticazione.</p>
            <div className="mt-3 flex gap-2">
              <Button disabled={changingVisibility} onClick={() => void setVisibility('public')} size="small">
                {changingVisibility && <Spinner />}
                Conferma accesso pubblico
              </Button>
              <Button disabled={changingVisibility} onClick={() => setConfirmPublic(false)} variant="ghost" size="small">Annulla</Button>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 sm:p-6">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">File</h3>
        </div>
        {error && <div className="mt-4"><ErrorMessage>{error}</ErrorMessage></div>}
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">
              <tr>
                <th className="px-4 py-3">Percorso</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3 text-right">Dimensione</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {files.map((file) => (
                <tr key={file.path}>
                  <td className="max-w-xs px-4 py-3">
                    <span className="flex items-center gap-2">
                      <FileCode2 aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs text-slate-700" title={file.path}>{file.path}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{file.contentType}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{formatBytes(file.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {files.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">Nessun file disponibile.</p>}
        </div>
        {fileCursor && (
          <Button className="mt-4" disabled={loadingFiles} onClick={() => void loadMoreFiles()} variant="secondary" size="small">
            {loadingFiles && <Spinner />}
            Carica altri file
          </Button>
        )}
      </div>
    </article>
  )
}

function DetailSkeleton() {
  return (
    <div aria-label="Caricamento dettagli" className="min-h-[34rem] animate-pulse rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="h-7 w-52 rounded bg-slate-100" />
      <div className="mt-3 h-4 w-72 max-w-full rounded bg-slate-100" />
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div className="h-12 rounded bg-slate-100" key={item} />)}
      </div>
      <div className="mt-10 h-56 rounded-lg bg-slate-100" />
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">{label}</dt>
      <dd className="mt-1.5 text-sm font-medium text-slate-800">{value}</dd>
    </div>
  )
}
