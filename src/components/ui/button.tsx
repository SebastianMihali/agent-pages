import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
type ButtonSize = 'default' | 'small' | 'icon'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-slate-950 text-white shadow-sm hover:bg-slate-800 focus-visible:ring-slate-400',
  secondary: 'border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:ring-slate-300',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-300',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-slate-300',
}

const sizes: Record<ButtonSize, string> = {
  default: 'h-10 px-4 text-sm',
  small: 'h-8 px-3 text-xs',
  icon: 'size-9',
}

export function Button({
  className,
  variant = 'primary',
  size = 'default',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
