import { useBlocker } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'

export function useDraftGuard() {
  const dirty = useRef(false)
  const pending = useRef<((leave: boolean) => void) | null>(null)
  const [open, setOpen] = useState(false)
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value }, [])
  const hasDrafts = useCallback(() => dirty.current, [])
  const confirmLeave = useCallback(async () => {
    if (!dirty.current) return true
    if (pending.current) return false
    setOpen(true)
    return new Promise<boolean>((resolve) => { pending.current = resolve })
  }, [])
  useBlocker({ shouldBlockFn: async () => !(await confirmLeave()), enableBeforeUnload: () => dirty.current })
  useEffect(() => () => { pending.current?.(false) }, [])

  function decide(leave: boolean) {
    if (leave) dirty.current = false
    pending.current?.(leave)
    pending.current = null
    setOpen(false)
  }

  const dialog = open ? <dialog aria-label="Leave unsaved changes" className="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl backdrop:bg-slate-950/40"
    ref={(element) => { if (element && !element.open) element.showModal() }} onCancel={() => decide(false)}>
    <h2 className="text-lg font-semibold text-slate-950">Leave your unsaved changes?</h2>
    <p className="mt-2 text-sm leading-6 text-slate-500">Your file drafts are kept in this tab. Leaving this site will discard them.</p>
    <div className="mt-5 flex flex-wrap gap-2"><Button variant="danger" onClick={() => decide(true)}>Discard and leave</Button><Button autoFocus variant="secondary" onClick={() => decide(false)}>Keep editing</Button></div>
  </dialog> : null

  return { onDirtyChange, confirmLeave, dialog, hasDrafts }
}
