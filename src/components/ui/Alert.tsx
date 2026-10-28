import type { ReactNode } from 'react'
import { cx } from './cx'

type Tone = 'info' | 'ok' | 'bad' | 'warn'

const tones: Record<Tone, string> = {
  info: 'bg-accent-50 text-accent-700 ring-accent-100',
  ok: 'bg-ok-50 text-ok-700 ring-ok-100',
  bad: 'bg-bad-50 text-bad-700 ring-bad-100',
  warn: 'bg-warn-50 text-warn-800 ring-warn-100',
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
      className={cx('rounded-xl px-4 py-3 text-sm ring-1 ring-inset', tones[tone], className)}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
    </div>
  )
}
