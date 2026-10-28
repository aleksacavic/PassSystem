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
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink-200/70">
      <p className="text-sm font-medium text-ink-500">{label}</p>
      <p
        className={cx(
          'mt-1 text-3xl font-bold tabular-nums tracking-tight',
          tone === 'ok' ? 'text-ok-700' : tone === 'warn' ? 'text-warn-800' : 'text-ink-900',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  )
}
