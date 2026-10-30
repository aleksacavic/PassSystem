import { cx } from './cx'

export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'success'
export type Size = 'sm' | 'md' | 'lg'

// Shapes, heights and colours come from the component/semantic tokens in src/styles/tokens.css.
const base =
  'inline-flex items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap transition-colors select-none touch-manipulation disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0'

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active',
  secondary: 'bg-surface text-fg ring-1 ring-inset ring-line hover:bg-surface-sunk active:bg-surface-muted',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-muted hover:text-fg active:bg-surface-strong',
  danger: 'bg-danger text-on-status hover:bg-danger-strong',
  'danger-ghost': 'bg-transparent text-danger-fg hover:bg-danger-soft active:bg-danger-muted',
  success: 'bg-success text-on-status hover:bg-success-strong',
}

const sizes: Record<Size, string> = {
  sm: 'min-h-(--control-sm) px-3 text-sm [&_svg]:size-4',
  md: 'min-h-(--control-md) px-4 text-[15px] [&_svg]:size-[18px]',
  lg: 'min-h-(--control-lg) px-6 text-lg [&_svg]:size-5',
}

/** Square buttons that show only an icon. */
const iconSizes: Record<Size, string> = {
  sm: 'size-(--control-sm) [&_svg]:size-4',
  md: 'size-(--control-md) [&_svg]:size-5',
  lg: 'size-(--control-lg) [&_svg]:size-6',
}

export function buttonClass(
  variant: Variant = 'primary',
  size: Size = 'md',
  extra?: string,
  iconOnly = false,
) {
  return cx(base, variants[variant], iconOnly ? iconSizes[size] : sizes[size], extra)
}
