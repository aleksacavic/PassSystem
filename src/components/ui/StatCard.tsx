import type { ReactNode } from 'react'
import { cx } from './cx'

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'ok' | 'warn'
}) {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card ring-1 ring-line">
      <p className="text-sm font-medium text-fg-subtle">{label}</p>
      <p
        className={cx(
          'mt-1 text-3xl font-bold tabular-nums tracking-tight',
          tone === 'ok' ? 'text-success-fg' : tone === 'warn' ? 'text-warning-fg' : 'text-fg',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-fg-subtle">{hint}</p>}
    </div>
  )
}
