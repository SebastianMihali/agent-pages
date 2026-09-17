import {
  Globe2,
  LayoutDashboard,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Brand } from '../brand'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { isUnauthorized, messageFrom, requestJson } from './api'
import type { Session } from './api'
import { ErrorMessage } from './error-message'
import { KeysSection } from './keys-section'
import { SitesSection } from './sites-section'
import { OverviewSection } from './overview-section'
import { useDraftGuard } from './use-draft-guard'

export function OwnerApp({ selectedSiteId, returnPath, onSelectSite, editorOpen, initialFile, onOpenEditor }: {
  selectedSiteId?: string
  editorOpen: boolean
  initialFile?: string
  onOpenEditor: (siteId: string, path?: string) => void
  returnPath?: string
  onSelectSite: (siteId: string | undefined, replace?: boolean) => void
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const loadSession = useCallback(async () => {
    try {
      setSessionError(null)
      setSession(await requestJson<Session>('/web/session'))
    } catch (error) {
      setSessionError(messageFrom(error))
    }
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  const handleUnauthorized = useCallback(() => {
    setSession(null)
    void loadSession()
  }, [loadSession])

  if (!session) {
    return <SessionLoading error={sessionError} onRetry={loadSession} />
  }
  if (!session.authenticated) {
    return <Login session={session} onAuthenticated={loadSession} />
  }
  return (
    <Dashboard
      editorOpen={editorOpen}
      initialFile={initialFile}
      onOpenEditor={onOpenEditor}
      onLoggedOut={loadSession}
      onSelectSite={onSelectSite}
      onUnauthorized={handleUnauthorized}
      returnPath={returnPath}
      selectedSiteId={selectedSiteId}
      session={session}
    />
  )
}

function SessionLoading({ error, onRetry }: { error: string | null; onRetry: () => Promise<void> }) {
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <Brand />
        {error ? (
          <>
            <ErrorMessage>{error}</ErrorMessage>
            <Button variant="secondary" onClick={() => void onRetry()}>
              <RefreshCw aria-hidden="true" className="size-4" />
              Retry
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner />
            Connecting…
          </div>
        )}
      </div>
    </main>
  )
}

function Login({ session, onAuthenticated }: {
  session: Extract<Session, { authenticated: false }>
  onAuthenticated: () => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await requestJson('/web/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, csrfToken: session.csrfToken }),
      })
      setPassword('')
      await onAuthenticated()
    } catch (cause) {
      setPassword('')
      setError(messageFrom(cause))
      // Login challenges are one-use even when credentials are rejected.
      await onAuthenticated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.72fr)]">
      <section className="hidden flex-col justify-between border-r border-slate-200 bg-white p-12 lg:flex">
        <Brand />
        <div className="max-w-xl pb-12">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            Self-hosted static hosting
          </p>
          <h1 className="text-balance text-5xl font-semibold leading-[1.06] tracking-[-0.045em] text-slate-950">
            Your sites, under your control.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-slate-500">
            Publish with your agents, manage visibility, and keep a stable address for every site.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <ShieldCheck aria-hidden="true" className="size-4" />
          New sites are always private
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Brand className="mb-14 lg:hidden" />
          <p className="text-sm font-medium text-slate-500">Owner area</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">Welcome back</h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Sign in to manage sites, visibility, and API keys.
          </p>

          <form className="mt-9 space-y-5" onSubmit={submit} aria-busy={busy}>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Username</span>
              <Input
                autoComplete="username"
                autoFocus
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
                required
                value={username}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Password</span>
              <Input
                autoComplete="current-password"
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button className="w-full" disabled={busy} size="default" type="submit">
              {busy && <Spinner />}
              Sign in
            </Button>
          </form>
        </div>
      </section>
    </main>
  )
}

function Dashboard({ session, selectedSiteId, returnPath, onSelectSite, onLoggedOut, onUnauthorized, editorOpen, initialFile, onOpenEditor }: {
  session: Extract<Session, { authenticated: true }>
  selectedSiteId?: string
  editorOpen: boolean
  initialFile?: string
  onOpenEditor: (siteId: string, path?: string) => void
  returnPath?: string
  onSelectSite: (siteId: string | undefined, replace?: boolean) => void
  onLoggedOut: () => Promise<void>
  onUnauthorized: () => void
}) {
  const [section, setSection] = useState<'overview' | 'sites' | 'keys'>(selectedSiteId ? 'sites' : 'overview')
  const { confirmLeave, dialog, onDirtyChange, hasDrafts } = useDraftGuard()
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (selectedSiteId) setSection('sites') }, [selectedSiteId, editorOpen])

  async function changeSection(next: 'overview' | 'sites' | 'keys') {
    if (next === section || !(await confirmLeave())) return
    setSection(next)
    if (next === 'overview') onSelectSite(undefined, true)
  }

  const sessionExpired = useCallback(() => {
    if (hasDrafts()) setError('Your session expired. Sign in in another tab, then retry. Your drafts are still here.')
    else onUnauthorized()
  }, [hasDrafts, onUnauthorized])

  async function logout() {
    if (!(await confirmLeave())) return
    setLoggingOut(true)
    setError(null)
    try {
      await requestJson('/web/logout', {
        method: 'POST',
        body: JSON.stringify({ csrfToken: session.csrfToken }),
      })
      await onLoggedOut()
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else setError(messageFrom(cause))
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className={`${editorOpen ? 'editor-shell flex h-dvh min-h-0 flex-col overflow-hidden' : 'min-h-screen'} bg-slate-50`}>
      {dialog}
      {!editorOpen && <header className="sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[92rem] items-center justify-between px-4 sm:px-6 lg:px-8">
          <Brand />
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-slate-500 sm:block">{session.username}</span>
            <Button aria-label="Sign out" disabled={loggingOut} onClick={() => void logout()} variant="ghost">
              {loggingOut ? <Spinner /> : <LogOut aria-hidden="true" className="size-4" />}
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>}

      <div className={`mx-auto w-full max-w-[92rem] px-4 sm:px-6 lg:px-8 ${editorOpen ? 'flex min-h-0 flex-1 flex-col py-3' : 'grid gap-8 py-7 lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-10'}`}>
        {!editorOpen && <nav aria-label="Main navigation" className="flex flex-wrap gap-2 lg:flex-col">
          <NavigationButton active={section === 'overview'} icon={<LayoutDashboard aria-hidden="true" className="size-4" />} onClick={() => void changeSection('overview')}>Overview</NavigationButton>
          <NavigationButton
            active={section === 'sites'}
            icon={<Globe2 aria-hidden="true" className="size-4" />}
            onClick={() => void changeSection('sites')}
          >
            Sites
          </NavigationButton>
          <NavigationButton
            active={section === 'keys'}
            icon={<KeyRound aria-hidden="true" className="size-4" />}
            onClick={() => void changeSection('keys')}
          >
            API keys
          </NavigationButton>
        </nav>}

        <div className={editorOpen ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'min-w-0'}>
          {error && <div className="mb-5"><ErrorMessage>{error}</ErrorMessage></div>}
          {section === 'overview' ? (
            <OverviewSection onSelectSite={(id) => { setSection('sites'); onSelectSite(id) }} onUnauthorized={onUnauthorized} />
          ) : section === 'sites' ? (
            <SitesSection
              editorOpen={editorOpen}
              initialFile={initialFile}
              onOpenEditor={onOpenEditor}
              onManageKeys={() => void changeSection('keys')}
              onDirtyChange={onDirtyChange}
              csrfToken={session.csrfToken}
              onSelectSite={onSelectSite}
              onUnauthorized={sessionExpired}
              returnPath={returnPath}
              selectedSiteId={selectedSiteId}
            />
          ) : (
            <KeysSection
              csrfToken={session.csrfToken}
              onError={setError}
              onUnauthorized={onUnauthorized}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function NavigationButton({ active, children, icon, onClick }: {
  active: boolean
  children: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
        active ? 'bg-white text-slate-950 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:bg-white hover:text-slate-950'
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      {children}
    </button>
  )
}
