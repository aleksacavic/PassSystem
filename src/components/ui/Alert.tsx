import type { ReactNode } from 'react'
import { cx } from './cx'

type Tone = 'info' | 'ok' | 'bad' | 'warn'

const tones: Record<Tone, string> = {
  info: 'bg-brand-soft text-brand-strong ring-brand-muted',
  ok: 'bg-success-soft text-success-fg ring-success-muted',
  bad: 'bg-danger-soft text-danger-fg ring-danger-muted',
  warn: 'bg-warning-soft text-warning-fg ring-warning-muted',
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cx('rounded-control px-4 py-3 text-sm ring-1 ring-inset', tones[tone], className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
    </div>
  )
}
