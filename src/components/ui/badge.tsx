import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'private' | 'public'
}) {
  const tones = {
    neutral: 'border-slate-200 bg-slate-50 text-slate-600',
    private: 'border-blue-200 bg-blue-50 text-blue-700',
    public: 'border-amber-200 bg-amber-50 text-amber-800',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
