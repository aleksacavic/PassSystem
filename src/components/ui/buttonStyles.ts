import { cx } from './cx'

export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
export type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation'

const variants: Record<Variant, string> = {
  primary: 'bg-ink-900 text-white hover:bg-ink-700 active:bg-ink-800',
  secondary: 'bg-white text-ink-900 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 active:bg-ink-200',
  ghost: 'bg-transparent text-ink-700 hover:bg-ink-100 active:bg-ink-200',
  danger: 'bg-bad-600 text-white hover:bg-bad-700',
  success: 'bg-ok-600 text-white hover:bg-ok-700',
}

const sizes: Record<Size, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-[15px]',
  lg: 'min-h-14 px-6 text-lg',
}

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra?: string) {
  return cx(base, variants[variant], sizes[size], extra)
}
