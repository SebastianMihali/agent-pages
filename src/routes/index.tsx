import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { OwnerApp } from '../components/owner/owner-app'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    site: typeof search.site === 'string' && /^[a-f0-9]{32}$/.test(search.site)
      ? search.site
      : undefined,
    view: search.view === 'files' ? 'files' as const : undefined,
    file: typeof search.file === 'string' && search.file.length <= 2048 ? search.file : undefined,
    returnPath: typeof search.returnPath === 'string'
      && search.returnPath.length <= 2048
      && search.returnPath.startsWith('/')
      && !search.returnPath.startsWith('//')
      ? search.returnPath
      : undefined,
  }),
  component: Home,
})

function Home() {
  const { returnPath, site, view, file } = Route.useSearch()
  const navigate = Route.useNavigate()
  const selectSite = useCallback((siteId: string | undefined, replace = false) => {
    void navigate({ search: { site: siteId, returnPath: undefined, view: undefined, file: undefined }, replace })
  }, [navigate])

  const openEditor = useCallback((siteId: string, path?: string) => {
    void navigate({ search: { site: siteId, view: 'files', file: path, returnPath: undefined } })
  }, [navigate])

  return <OwnerApp editorOpen={view === 'files' && !!site} initialFile={file} onOpenEditor={openEditor} onSelectSite={selectSite} returnPath={returnPath} selectedSiteId={site} />
}
