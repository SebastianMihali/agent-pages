import { PanelsTopLeft } from 'lucide-react'
import { cn } from './ui/cn'

export function Brand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-slate-950 text-white shadow-sm">
        <PanelsTopLeft aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
      </span>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-[-0.02em] text-slate-950">
          Agent Pages
        </span>
      )}
    </div>
  )
}
