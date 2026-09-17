import {
  ChevronRight,
  Clock3,
  FileCode2,
  Globe2,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SiteOverview, SiteView } from '../../server/sites'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  formatBytes,
  formatDate,
  formatRelative,
  isUnauthorized,
  messageFrom,
  requestJson,
} from './api'
import { ErrorMessage } from './error-message'

export function OverviewSection({ onSelectSite, onUnauthorized }: {
  onSelectSite: (siteId: string) => void
  onUnauthorized: () => void
}) {
  const requestId = useRef(0)
  const [overview, setOverview] = useState<SiteOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)

    try {
      const result = await requestJson<SiteOverview>('/web/overview')
      if (currentRequest === requestId.current) setOverview(result)
    } catch (cause) {
      if (currentRequest !== requestId.current) return
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void loadOverview()
    return () => { requestId.current += 1 }
  }, [loadOverview])

  return (
    <section aria-labelledby="overview-heading">
      <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Workspace</p>
          <h1 id="overview-heading" className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">Overview</h1>
          <p className="mt-2 text-sm text-slate-500">A quick view of your active sites and their content.</p>
        </div>
        <Button
          aria-label="Refresh overview"
          disabled={loading}
          onClick={() => void loadOverview()}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1"><ErrorMessage>{error}</ErrorMessage></div>
          {!overview && <Button onClick={() => void loadOverview()} variant="secondary">Try again</Button>}
        </div>
      )}

      {!overview && loading ? (
        <OverviewSkeleton />
      ) : overview ? (
        <div aria-busy={loading}>
          <div className="grid grid-flow-dense grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <StatCard icon={<Globe2 aria-hidden="true" className="size-5" />} label="Active sites" value={overview.activeSites}>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="public">{overview.publicSites} public</Badge>
                <Badge tone="private">{overview.privateSites} private</Badge>
              </div>
            </StatCard>
            <StatCard icon={<FileCode2 aria-hidden="true" className="size-5" />} label="Files" value={overview.fileCount}>
              Across all active sites
            </StatCard>
            <StatCard icon={<HardDrive aria-hidden="true" className="size-5" />} label="Content size" value={formatBytes(overview.sizeBytes)}>
              Stored in active revisions
            </StatCard>
            <StatCard icon={<Clock3 aria-hidden="true" className="size-5" />} label="Expiring soon" value={overview.expiringSoon}>
              Within the next 72 hours
            </StatCard>
          </div>

          {overview.activeSites === 0 ? (
            <EmptyOverview />
          ) : (
            <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-2">
              <SiteList
                emptyMessage="Sites you update will appear here."
                heading="Recently updated"
                onSelectSite={onSelectSite}
                sites={overview.recentSites.slice(0, 5)}
                timestamp={(site) => `Updated ${formatRelative(site.updatedAt)}`}
              />
              <SiteList
                emptyMessage="No sites expire in the next 72 hours."
                heading="Expiring soon"
                onSelectSite={onSelectSite}
                sites={overview.expiringSites.slice(0, 5)}
                timestamp={(site) => site.expiresAt ? `Expires ${formatDate(site.expiresAt)}` : 'No expiration'}
              />
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

function StatCard({ children, icon, label, value }: {
  children: ReactNode
  icon: ReactNode
  label: string
  value: number | string
}) {
  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <span className="hidden size-9 shrink-0 sm:grid place-items-center rounded-lg bg-slate-100 text-slate-600">{icon}</span>
      </div>
      <p className="mt-4 truncate text-3xl font-semibold tracking-[-0.035em] text-slate-950">{value}</p>
      <div className="mt-3 min-h-6 text-xs leading-6 text-slate-500">{children}</div>
    </article>
  )
}

function SiteList({ emptyMessage, heading, onSelectSite, sites, timestamp }: {
  emptyMessage: string
  heading: string
  onSelectSite: (siteId: string) => void
  sites: readonly SiteView[]
  timestamp: (site: SiteView) => string
}) {
  return (
    <section aria-label={heading} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
      </div>
      {sites.length === 0 ? (
        <div className="grid min-h-40 place-items-center px-6 py-10 text-center">
          <div>
            <Clock3 aria-hidden="true" className="mx-auto size-5 text-slate-300" />
            <p className="mt-3 text-sm text-slate-500">{emptyMessage}</p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {sites.map((site) => (
            <button
              className="flex w-full min-w-0 items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300"
              key={site.id}
              onClick={() => onSelectSite(site.id)}
              type="button"
            >
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-900">{site.name}</span>
                  <Badge className="shrink-0" tone={site.visibility}>{site.visibility}</Badge>
                </span>
                <span className="mt-1 block truncate text-xs text-slate-500">
                  {timestamp(site)} · {site.fileCount} {site.fileCount === 1 ? 'file' : 'files'} · {formatBytes(site.sizeBytes)}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-slate-300" />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function EmptyOverview() {
  return (
    <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
      <span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-500">
        <Globe2 aria-hidden="true" className="size-5" />
      </span>
      <p className="mt-4 text-sm font-medium text-slate-800">No active sites</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">Create your first site through REST or MCP to see activity here.</p>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div aria-label="Loading overview" aria-live="polite">
      <span className="sr-only">Loading overview…</span>
      <div className="grid grid-flow-dense grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" key={item}>
            <div className="h-4 w-24 rounded bg-slate-100" />
            <div className="mt-6 h-9 w-20 rounded bg-slate-100" />
            <div className="mt-4 h-5 w-full max-w-32 rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        {[0, 1].map((item) => <div className="h-64 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm" key={item} />)}
      </div>
    </div>
  )
}
