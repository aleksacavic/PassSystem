import { ChevronDown, RefreshCw } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { listAllRegistrations } from '../../../lib/api'
import { registrationHistory, type HistoryBucket } from '../../../lib/registrationHistory'
import { useIsCurrent } from '../../../lib/useIsCurrent'
import type { EventRow } from '../../../lib/types'
import { Alert, Button, Card, Spinner, cx } from '../../../components/ui'

/** Clean upper bound for the y axis: 1, 2, 5, 10, 20, 50, ... */
function niceMax(n: number): number {
  if (n <= 1) return 1
  const step = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 5, 10]) if (m * step >= n) return m * step
  return 10 * step
}

/**
 * When people registered, per hour or per day. Collapsed by default; the
 * registrations are loaded only when it is first opened.
 */
export function RegistrationHistory({ event }: { event: EventRow }) {
  const isCurrent = useIsCurrent()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [times, setTimes] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asTable, setAsTable] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const rows = await listAllRegistrations(event.id)
      if (isCurrent()) setTimes(rows.map((r) => r.registered_at))
    } catch (e) {
      if (isCurrent()) setError((e as Error).message)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  function toggle() {
    setOpen((o) => !o)
    if (!open && times === null && !loading) void load()
  }

  const history = useMemo(
    () => (times ? registrationHistory(times, event.timezone) : null),
    [times, event.timezone],
  )

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-start sm:px-5"
      >
        <span>
          <span className="block text-base font-semibold text-fg">Registration history</span>
          <span className="block text-sm text-fg-muted">When people registered over time</span>
        </span>
        <ChevronDown
          className={cx('size-5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id={panelId} className="space-y-4 border-t border-line-soft px-4 py-4 sm:px-5">
          {error && <Alert tone="bad">{error}</Alert>}
          {!history ? (
            loading && (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            )
          ) : history.total === 0 ? (
            <p className="text-center text-sm text-fg-subtle">No registrations yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-3xl leading-none font-semibold tabular-nums text-fg">
                    {history.total.toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-fg-muted">
                    registrations
                    {history.peak && history.peak.count > 0 && (
                      <>
                        {' '}
                        · busiest {history.unit === 'hour' ? 'hour' : 'day'}{' '}
                        <span className="font-semibold text-fg">{history.peak.title}</span> (
                        {history.peak.count})
                      </>
                    )}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setAsTable((t) => !t)}>
                    {asTable ? 'Show chart' : 'Show as table'}
                  </Button>
                  <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load} loading={loading}>
                    Refresh
                  </Button>
                </div>
              </div>
              {asTable ? (
                <HistoryTable buckets={history.buckets} unit={history.unit} />
              ) : (
                <HistoryChart buckets={history.buckets} unit={history.unit} />
              )}
              <p className="text-xs text-fg-subtle">
                Per {history.unit}, in the event’s time zone ({event.timezone}). Includes passes that were
                later revoked.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

function HistoryChart({ buckets, unit }: { buckets: HistoryBucket[]; unit: 'hour' | 'day' }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = niceMax(Math.max(...buckets.map((b) => b.count)))
  // About six axis labels, whatever the number of bars.
  const every = Math.max(1, Math.ceil(buckets.length / 6))
  const shown = hover !== null ? buckets[hover] : null
  // A middle gridline only where it has a whole-number label.
  const ticks = max % 2 === 0 ? [max, max / 2, 0] : [max, 0]

  return (
    <div>
      {/* Readout for the bar under the pointer; also visible as each bar's accessible name. */}
      <p className="mb-3 h-5 text-sm text-fg-muted" aria-live="polite">
        {shown && (
          <>
            <span className="font-semibold text-fg tabular-nums">{shown.count}</span>{' '}
            {shown.count === 1 ? 'registration' : 'registrations'} · {shown.title}
          </>
        )}
      </p>
      <div className="flex gap-2">
        <div className="relative h-40 w-8 shrink-0 text-end text-xs text-fg-subtle tabular-nums">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute end-0 -translate-y-1/2"
              style={{ top: `${(1 - t / max) * 100}%` }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ minWidth: `${buckets.length * 8}px` }}>
            <div className="relative h-40">
              {ticks.map((t) => (
                <div
                  key={t}
                  aria-hidden="true"
                  className="absolute inset-x-0 border-t border-line-soft"
                  style={{ top: `${(1 - t / max) * 100}%` }}
                />
              ))}
              <ul
                className="absolute inset-0 flex items-end gap-0.5"
                aria-label={`Registrations per ${unit}`}
                onPointerLeave={() => setHover(null)}
              >
                {buckets.map((b, i) => (
                  <li
                    key={b.key}
                    className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                    onPointerEnter={() => setHover(i)}
                    aria-label={`${b.title}: ${b.count}`}
                    title={`${b.title}: ${b.count}`}
                    data-testid="history-bar"
                  >
                    <div
                      className={cx(
                        'w-full max-w-6 rounded-t bg-brand-bright transition-opacity',
                        hover !== null && hover !== i && 'opacity-60',
                      )}
                      style={{ height: b.count ? `${(b.count / max) * 100}%` : 0 }}
                    />
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-1 flex gap-0.5 text-xs text-fg-subtle" aria-hidden="true">
              {buckets.map((b, i) => (
                <span key={b.key} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
                  {i % every === 0 ? b.label : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function HistoryTable({ buckets, unit }: { buckets: HistoryBucket[]; unit: 'hour' | 'day' }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-control ring-1 ring-line-soft">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface-sunk text-xs font-semibold text-fg-subtle uppercase">
          <tr>
            <th className="px-3 py-2 text-start">{unit === 'hour' ? 'Hour' : 'Day'}</th>
            <th className="px-3 py-2 text-end">Registrations</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {buckets.map((b) => (
            <tr key={b.key}>
              <td className="px-3 py-1.5">{b.title}</td>
              <td className="px-3 py-1.5 text-end tabular-nums">{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
