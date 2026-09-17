import { useState } from 'react'
import type { SiteView } from '../../server/sites'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { ApiFailure, isUnauthorized, isVersionConflict, messageFrom, readSiteManifest, requestJson } from './api'
import type { Session } from './api'
import { ErrorMessage } from './error-message'

export function FileDeletionDialog({ site, path, onClose, onDeleted, onReload }: {
  site: SiteView; path: string; onClose: () => void; onDeleted: () => void; onReload: () => void
}) {
  const [command, setCommand] = useState(() => ({ operationId: crypto.randomUUID(), expectedVersion: site.version, paths: [path] }))
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(path !== 'index.html')
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  async function remove() {
    if (busy || !ready) return
    setBusy(true); setError(null)
    try {
      const session = await requestJson<Session>('/web/session')
      if (!session.authenticated) throw new ApiFailure('Sign in again, then retry deletion.', 401)
      await requestJson(`/web/sites/${encodeURIComponent(site.id)}/files/delete`, { method: 'POST', body: JSON.stringify({ csrfToken: session.csrfToken, ...command }) })
      onDeleted()
    } catch (cause) {
      setAuthExpired(isUnauthorized(cause))
      if (isVersionConflict(cause)) {
        setReady(false)
        try {
          const latest = await readSiteManifest(site.id)
          onReload()
          if (!latest.files.some((file) => file.path === path)) setError('This file has already been deleted. Close this dialog to continue.')
          else {
            setCommand({ operationId: crypto.randomUUID(), expectedVersion: latest.site.version, paths: [path] }); setReady(true)
            setError('This site changed. Review the file path and confirm deletion again.')
          }
        } catch (reloadFailure) { setError(messageFrom(reloadFailure)) }
      } else setError(messageFrom(cause))
    } finally { setBusy(false) }
  }
  return <dialog aria-label="Delete site file" className="m-auto w-[calc(100%_-_2rem)] max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-950/40"
    ref={(dialog) => { if (dialog && !dialog.open) dialog.showModal() }} onCancel={(event) => { if (busy) event.preventDefault(); else onClose() }}>
    <h3 className="text-lg font-semibold text-slate-950">Delete file?</h3>
    <p className="mt-2 break-all text-sm text-slate-600">Delete <strong>{path}</strong> from this site? This publishes a revision without the file.</p>
    {site.visibility === 'public' && <p className="mt-2 text-sm text-amber-800">This site is public. Changes are visible to visitors immediately.</p>}
    {error && <div className="mt-4"><ErrorMessage>{error}</ErrorMessage></div>}
    {authExpired && <a href="/" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-blue-700 underline">Sign in in a new tab, then retry</a>}
    <div className="mt-5 flex gap-2"><Button variant="danger" disabled={busy || !ready} onClick={() => void remove()}>{busy && <Spinner />}Delete file</Button><Button autoFocus variant="secondary" disabled={busy} onClick={onClose}>Cancel deletion</Button></div>
  </dialog>
}
