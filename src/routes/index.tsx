import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { OwnerApp } from '../components/owner/owner-app'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    site: typeof search.site === 'string' && /^[a-f0-9]{32}$/.test(search.site)
      ? search.site
      : undefined,
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
  const { returnPath, site } = Route.useSearch()
  const navigate = Route.useNavigate()
  const selectSite = useCallback((siteId: string, replace = false) => {
    void navigate({ search: { site: siteId, returnPath: undefined }, replace })
  }, [navigate])

  return <OwnerApp onSelectSite={selectSite} returnPath={returnPath} selectedSiteId={site} />
}
