import type { ReactNode } from 'react'
import { cx } from './cx'

type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'accent'

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-fg ring-line',
  ok: 'bg-success-soft text-success-fg ring-success-muted',
  bad: 'bg-danger-soft text-danger-fg ring-danger-muted',
  warn: 'bg-warning-soft text-warning-fg ring-warning-muted',
  accent: 'bg-brand-soft text-brand-strong ring-brand-muted',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
