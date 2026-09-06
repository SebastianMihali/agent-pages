import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import {
  formatDate,
  isUnauthorized,
  messageFrom,
  requestJson,
} from './api'
import type { ApiKeySummary, CreatedApiKey } from './api'

export function KeysSection({ csrfToken, onError, onUnauthorized }: {
  csrfToken: string
  onError: (message: string | null) => void
  onUnauthorized: () => void
}) {
  const [keys, setKeys] = useState<ApiKeySummary[]>([])
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const loadKeys = useCallback(async () => {
    setLoading(true)
    onError(null)
    try {
      const result = await requestJson<{ keys: ApiKeySummary[] }>('/web/keys')
      setKeys(result.keys)
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else onError(messageFrom(cause))
    } finally {
      setLoading(false)
    }
  }, [onError, onUnauthorized])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setCopied(false)
    onError(null)
    try {
      const next = await requestJson<CreatedApiKey>('/web/keys', {
        method: 'POST',
        body: JSON.stringify({ csrfToken, label }),
      })
      setCreated(next)
      setLabel('')
      await loadKeys()
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else onError(messageFrom(cause))
    } finally {
      setBusy(false)
    }
  }

  async function copyKey() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.key)
      setCopied(true)
    } catch {
      onError('Automatic copy is unavailable. Select the key and copy it manually.')
    }
  }

  async function revokeKey(keyId: string) {
    setBusy(true)
    onError(null)
    try {
      await requestJson(`/web/keys/${encodeURIComponent(keyId)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ csrfToken }),
      })
      setConfirmRevoke(null)
      await loadKeys()
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorized()
      else onError(messageFrom(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="keys-heading" className="max-w-4xl">
      <div className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Agent access</p>
        <h1 id="keys-heading" className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-slate-950">API keys</h1>
        <p className="mt-2 text-sm text-slate-500">Create personal credentials for REST and MCP. Each key has full access to your sites.</p>
      </div>

      {created && (
        <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5" role="status">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-emerald-950">Save this key now</p>
              <p className="mt-1 text-xs leading-5 text-emerald-800">This key is shown only once. Do not put it in public files or browser code.</p>
            </div>
            <Button aria-label="Hide key" onClick={() => setCreated(null)} variant="ghost" size="small">Close</Button>
          </div>
          <div className="mt-4 flex gap-2">
            <Input aria-label="New API key" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} readOnly value={created.key} />
            <Button aria-label="Copy API key" onClick={() => void copyKey()} variant="secondary" size="icon">
              {copied ? <Check aria-hidden="true" className="size-4 text-emerald-600" /> : <Copy aria-hidden="true" className="size-4" />}
            </Button>
          </div>
          {copied && <p className="mt-2 text-xs font-medium text-emerald-700">Copied to clipboard.</p>}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-slate-900">Create a key</h2>
          <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={createKey}>
            <label className="sr-only" htmlFor="key-label">Key label</label>
            <Input
              disabled={busy}
              id="key-label"
              maxLength={100}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Codex on my laptop"
              required
              value={label}
            />
            <Button disabled={busy || !label.trim()} type="submit">
              {busy ? <Spinner /> : <Plus aria-hidden="true" className="size-4" />}
              Create key
            </Button>
          </form>
        </div>

        <div className="divide-y divide-slate-100">
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-slate-500"><Spinner /> Loading keys…</div>
          ) : keys.length === 0 ? (
            <div className="p-8 text-center">
              <KeyRound aria-hidden="true" className="mx-auto size-5 text-slate-300" />
              <p className="mt-3 text-sm text-slate-500">You have not created any API keys yet.</p>
            </div>
          ) : keys.map((key) => (
            <div className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center sm:px-6" key={key.id}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{key.label}</p>
                <p className="mt-1 font-mono text-xs text-slate-400">{key.prefix}•••••• · Created {formatDate(key.createdAt)}</p>
              </div>
              {confirmRevoke === key.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Revoke now?</span>
                  <Button disabled={busy} onClick={() => void revokeKey(key.id)} variant="danger" size="small">Confirm</Button>
                  <Button disabled={busy} onClick={() => setConfirmRevoke(null)} variant="ghost" size="small">Cancel</Button>
                </div>
              ) : (
                <Button onClick={() => setConfirmRevoke(key.id)} variant="ghost" size="small">
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
