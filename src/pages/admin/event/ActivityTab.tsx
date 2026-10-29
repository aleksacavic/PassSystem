import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listScanActivity, type ScanActivityRow } from '../../../lib/api'
import { formatDateTime } from '../../../lib/datetime'
import { usePolling } from '../../../lib/usePolling'
import type { AdmissionResult, EventRow } from '../../../lib/types'
import { Alert, Badge, Button, Card, CardHeader, Input, Select, Spinner } from '../../../components/ui'
import { ScanHistory } from './ScanHistory'

const LABELS: Record<AdmissionResult, { label: string; tone: 'ok' | 'bad' | 'warn' }> = {
  admitted: { label: 'Admitted', tone: 'ok' },
  already_used: { label: 'Already used', tone: 'bad' },
  invalid: { label: 'Invalid', tone: 'bad' },
  revoked: { label: 'Revoked', tone: 'bad' },
  wrong_event: { label: 'Wrong event', tone: 'warn' },
}

const PAGE_SIZE = 50

/** Every scan attempt of the event, newest first, searchable and paged. */
export function ActivityTab({ event }: { event: EventRow }) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [result, setResult] = useState<AdmissionResult | 'all'>('all')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ rows: ScanActivityRow[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(t)
  }, [search])

  // As on the Registrations tab: only the latest request for the filters shown may update the list.
  const latest = useRef(0)
  const shownQuery = useRef('')
  const query = JSON.stringify([debounced, result, page])
  useLayoutEffect(() => {
    shownQuery.current = query
  }, [query])

  const load = useCallback(() => {
    const request = ++latest.current
    const forQuery = JSON.stringify([debounced, result, page])
    const current = () => request === latest.current && forQuery === shownQuery.current
    listScanActivity({ eventId: event.id, search: debounced, result, page, pageSize: PAGE_SIZE })
      .then((d) => {
        if (!current()) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => current() && setError(e.message))
  }, [event.id, debounced, result, page])

  useEffect(load, [load])
  usePolling(load, 10_000)

  const filtered = search.trim() !== '' || result !== 'all'
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  function clearSearch() {
    setSearch('')
    setDebounced('')
    setPage(0)
    searchInput.current?.focus()
  }

  function clearAll() {
    clearSearch()
    setResult('all')
  }

  return (
    <div className="space-y-4">
      <ScanHistory event={event} />

      {/* Same layout as the Attendees toolbar: search on its own row below lg. */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative min-w-0 lg:max-w-sm lg:min-w-72 lg:flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <Input
            ref={searchInput}
            type="search"
            enterKeyHint="search"
            placeholder="Search name, email or phone"
            aria-label="Search scans"
            className="ps-9 pe-10 [&::-webkit-search-cancel-button]:appearance-none"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={clearSearch}
              className="absolute end-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-fg-subtle hover:bg-surface-sunk hover:text-fg"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:contents">
          <div className="min-w-44 flex-1 lg:w-48 lg:flex-none">
            <Select
              aria-label="Filter by result"
              value={result}
              onChange={(e) => {
                setResult(e.target.value as AdmissionResult | 'all')
                setPage(0)
              }}
            >
              <option value="all">All results</option>
              {(Object.keys(LABELS) as AdmissionResult[]).map((r) => (
                <option key={r} value={r}>
                  {LABELS[r].label}
                </option>
              ))}
            </Select>
          </div>
          {filtered && (
            <div className="order-last flex w-full justify-end lg:order-none lg:w-auto">
              <Button variant="ghost" size="sm" icon={X} onClick={clearAll}>
                Clear all
              </Button>
            </div>
          )}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Scan activity"
          description={
            data
              ? `${data.total.toLocaleString()} server-validated scan ${data.total === 1 ? 'attempt' : 'attempts'}${filtered ? ' match' : ''}, newest first.`
              : 'Every server-validated scan attempt, newest first.'
          }
        />
        {error && (
          <Alert tone="bad" className="m-4">
            {error}
          </Alert>
        )}
        {!data ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : data.rows.length === 0 ? (
          <div className="space-y-3 p-6 text-center text-fg-subtle">
            <p>{filtered ? 'No scans match these filters.' : 'No scans yet.'}</p>
            {filtered && (
              <Button variant="secondary" size="sm" icon={X} onClick={clearAll}>
                Clear all
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line-soft">
            {data.rows.map((l) => {
              const meta = LABELS[l.result]
              const r = l.registration
              return (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {r
                        ? `${r.first_name} ${r.last_name}`
                        : l.result === 'wrong_event'
                          ? 'Pass from another event'
                          : 'Unknown pass'}
                    </p>
                    <p className="text-xs text-fg-subtle">{formatDateTime(l.attempted_at, event.timezone)}</p>
                  </div>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {data && pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-fg-muted">
            Page {page + 1} of {pages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
