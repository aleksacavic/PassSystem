import type { ReactNode } from 'react'
import { cx } from './cx'

type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'accent'

const tones: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  ok: 'bg-ok-50 text-ok-700 ring-ok-100',
  bad: 'bg-bad-50 text-bad-700 ring-bad-100',
  warn: 'bg-warn-50 text-warn-800 ring-warn-100',
  accent: 'bg-accent-50 text-accent-700 ring-accent-100',
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
