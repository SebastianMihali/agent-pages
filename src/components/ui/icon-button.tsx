import { useId, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './button'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null)
  return <span className="inline-flex shrink-0" onPointerEnter={(event) => show(event.currentTarget)} onPointerLeave={() => setPosition(null)}
    onFocus={(event) => show(event.currentTarget)} onBlur={() => setPosition(null)} onKeyDown={(event) => { if (event.key === 'Escape') setPosition(null) }}>
    {children}
    {position && createPortal(<span id={id} role="tooltip" className="pointer-events-none fixed z-50 max-w-56 rounded-md bg-slate-900 px-2.5 py-1.5 text-center text-xs leading-5 text-white shadow-md"
      style={{ left: position.left, top: position.top, transform: `translate(-50%, ${position.above ? '-100%' : '0'})` }}>{label}</span>, document.body)}
  </span>

  function show(element: HTMLSpanElement) {
    const rect = element.getBoundingClientRect()
    const above = rect.bottom + 56 > window.innerHeight
    setPosition({ left: Math.max(116, Math.min(window.innerWidth - 116, rect.left + rect.width / 2)), top: above ? rect.top - 8 : rect.bottom + 8, above })
  }
}

export function IconButton({ label, ...props }: Omit<ComponentProps<typeof Button>, 'size'> & { label: string }) {
  return <Tooltip label={label}><Button {...props} aria-label={label} size="icon" /></Tooltip>
}
