import { Ban, Download, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  listAllRegistrations,
  listRegistrations,
  reissuePass,
  restoreRegistration,
  revokeRegistration,
} from '../../../lib/api'
import { downloadText, toCsv } from '../../../lib/csv'
import { formatDateTime } from '../../../lib/datetime'
import { formatPassToken, passUrl } from '../../../lib/passToken'
import { safeFilename } from '../../../lib/qr'
import { useIsCurrent } from '../../../lib/useIsCurrent'
import { usePolling } from '../../../lib/usePolling'
import type { EventRow, Registration, RegistrationStatus } from '../../../lib/types'
import { CopyButton } from '../../../components/CopyButton'
import { Modal } from '../../../components/Modal'
import { QrImage } from '../../../components/QrImage'
import { useQrDataUrl } from '../../../components/useQrDataUrl'
import { RegistrationStatusBadge } from '../../../components/StatusBadge'
import { Alert, Button, Card, Input, Select, Spinner } from '../../../components/ui'
import { RegistrationHistory } from './RegistrationHistory'

const PAGE_SIZE = 50

export function AttendeesTab({ event, onChanged }: { event: EventRow; onChanged: () => void }) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<RegistrationStatus | 'all'>('all')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ rows: Registration[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [action, setAction] = useState<{ reg: Registration; kind: 'revoke' | 'restore' | 'reissue' } | null>(
    null,
  )

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(t)
  }, [search])

  // Only the latest request for the filters now shown may update the list: a
  // slower, older one (a search since cleared, a previous page, an earlier poll)
  // is ignored when it arrives (R16-02, R17-01).
  const latest = useRef(0)
  const shownQuery = useRef('')
  const searchInput = useRef<HTMLInputElement>(null)
  const query = JSON.stringify([debounced, status, page])
  useLayoutEffect(() => {
    shownQuery.current = query
  }, [query])

  const load = useCallback(() => {
    const request = ++latest.current
    const forQuery = JSON.stringify([debounced, status, page])
    const current = () => request === latest.current && forQuery === shownQuery.current
    listRegistrations({ eventId: event.id, search: debounced, status, page, pageSize: PAGE_SIZE })
      .then((d) => {
        if (!current()) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => current() && setError(e.message))
  }, [event.id, debounced, status, page])

  // Callbacks that outlive a render (a dialog finishing late) reload with the filters
  // shown now, not the ones they were created with (R17-01).
  const loadLatest = useRef(load)
  useEffect(() => {
    loadLatest.current = load
  }, [load])

  useEffect(load, [load])
  usePolling(load, 15_000)

  async function exportCsv() {
    setExporting(true)
    setError(null)
    try {
      const rows = await listAllRegistrations(event.id)
      const csv = toCsv(
        [
          'First name',
          'Last name',
          'Email',
          'Phone',
          'Status',
          'Registered at (UTC)',
          'Checked in at (UTC)',
          'Terms accepted at (UTC)',
          'Registration ID',
        ],
        rows.map((r) => [
          r.first_name,
          r.last_name,
          r.email ?? '',
          r.phone ?? '',
          r.status,
          r.registered_at,
          r.checked_in_at ?? '',
          r.terms_accepted_at ?? '',
          r.id,
        ]),
      )
      downloadText(`attendees-${safeFilename(event.slug)}-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const filtered = search.trim() !== '' || status !== 'all'

  function clearSearch() {
    setSearch('')
    setDebounced('')
    setPage(0)
    searchInput.current?.focus() // keep typing without reaching for the field again
  }

  function clearAll() {
    clearSearch()
    setStatus('all')
  }

  return (
    <div className="space-y-4">
      <RegistrationHistory event={event} />

      {/* Search gets its own full-width row on phones and tablets; side by side with the filters
          only from lg up, where it keeps a usable minimum width (R16-01). */}
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
            aria-label="Search attendees"
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
          {/* Wrapper sets the width: the shared control class is w-full. Its minimum fits the
              longest status label; Export wraps below it on the narrowest phones. */}
          <div className="min-w-44 flex-1 lg:w-48 lg:flex-none">
            <Select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as RegistrationStatus | 'all')
                setPage(0)
              }}
            >
              <option value="all">All statuses</option>
              <option value="registered">Not checked in</option>
              <option value="checked_in">Checked in</option>
              <option value="revoked">Revoked</option>
            </Select>
          </div>
          {filtered && (
            // Below lg: its own line under the filters, so the status menu keeps its width.
            <div className="order-last flex w-full justify-end lg:order-none lg:w-auto">
              <Button variant="ghost" size="sm" icon={X} onClick={clearAll}>
                Clear all
              </Button>
            </div>
          )}
          <div className="hidden lg:block lg:flex-1" />
          <Button variant="secondary" icon={Download} onClick={exportCsv} loading={exporting}>
            Export CSV
          </Button>
        </div>
      </div>

      {error && <Alert tone="bad">{error}</Alert>}

      <Card className="overflow-hidden">
        {!data ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : data.rows.length === 0 ? (
          <div className="space-y-3 p-8 text-center text-fg-subtle">
            <p>{filtered ? 'No attendees match these filters.' : 'No attendees yet.'}</p>
            {filtered && (
              <Button variant="secondary" size="sm" icon={X} onClick={clearAll}>
                Clear all
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-left text-sm md:table">
              <thead className="bg-surface-sunk text-xs font-semibold tracking-wide text-fg-subtle uppercase">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Registered</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Checked in</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid="attendee-row">
                    <td className="px-4 py-3 font-semibold">
                      {r.first_name} {r.last_name}
                    </td>
                    <td className="max-w-56 px-4 py-3 text-fg-muted">
                      <div className="truncate">{r.email ?? (r.phone ? '' : '—')}</div>
                      {r.phone && <div className="truncate tabular-nums">{r.phone}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
                      {formatDateTime(r.registered_at, event.timezone)}
                    </td>
                    <td className="px-4 py-3">
                      <RegistrationStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
                      {formatDateTime(r.checked_in_at, event.timezone)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowActions reg={r} onAction={(kind) => setAction({ reg: r, kind })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Mobile list */}
            <ul className="divide-y divide-line-soft md:hidden">
              {data.rows.map((r) => (
                <li key={r.id} className="space-y-1 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">
                      {r.first_name} {r.last_name}
                    </p>
                    <RegistrationStatusBadge status={r.status} />
                  </div>
                  {r.email && <p className="truncate text-sm text-fg-muted">{r.email}</p>}
                  {r.phone && <p className="truncate text-sm text-fg-muted tabular-nums">{r.phone}</p>}
                  <p className="text-xs text-fg-subtle">
                    Registered {formatDateTime(r.registered_at, event.timezone)}
                    {r.checked_in_at && ` · In ${formatDateTime(r.checked_in_at, event.timezone)}`}
                  </p>
                  <div className="pt-1">
                    <RowActions reg={r} onAction={(kind) => setAction({ reg: r, kind })} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-fg-muted">
            {data.total} attendees · page {page + 1} of {pages}
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
      {data && data.total <= PAGE_SIZE && data.total > 0 && (
        <p className="text-sm text-fg-subtle">{data.total} attendees</p>
      )}

      {action && (
        <ActionModal
          key={`${action.reg.id}:${action.kind}`}
          event={event}
          reg={action.reg}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={() => {
            loadLatest.current()
            onChanged()
          }}
        />
      )}
    </div>
  )
}

function RowActions({
  reg,
  onAction,
}: {
  reg: Registration
  onAction: (k: 'revoke' | 'restore' | 'reissue') => void
}) {
  if (reg.status === 'checked_in') return null
  return (
    <div className="inline-flex gap-1">
      {reg.status === 'registered' && (
        <>
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => onAction('reissue')}>
            Reissue
          </Button>
          <Button variant="danger-ghost" size="sm" icon={Ban} onClick={() => onAction('revoke')}>
            Revoke
          </Button>
        </>
      )}
      {reg.status === 'revoked' && (
        <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => onAction('restore')}>
          Restore
        </Button>
      )}
    </div>
  )
}

function ActionModal({
  event,
  reg,
  kind,
  onClose,
  onDone,
}: {
  event: EventRow
  reg: Registration
  kind: 'revoke' | 'restore' | 'reissue'
  onClose: () => void
  onDone: () => void
}) {
  const isCurrent = useIsCurrent()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const url = token ? passUrl(token) : null
  const qr = useQrDataUrl(url)
  const name = `${reg.first_name} ${reg.last_name}`

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      let issued: string | null = null
      if (kind === 'revoke') await revokeRegistration(reg.id)
      if (kind === 'restore') await restoreRegistration(reg.id)
      if (kind === 'reissue') issued = await reissuePass(reg.id)
      onDone() // refresh the list in any case
      // If this dialog was dismissed meanwhile, do not close or change the one now open (R13-02).
      if (!isCurrent()) return
      if (issued) setToken(issued)
      if (kind !== 'reissue') onClose()
    } catch (e) {
      if (isCurrent()) setError((e as Error).message)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const titles = { revoke: 'Revoke pass', restore: 'Restore pass', reissue: 'Reissue pass' }

  return (
    <Modal
      open
      title={titles[kind]}
      onClose={onClose}
      footer={
        token ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant={kind === 'revoke' ? 'danger' : 'primary'} loading={busy} onClick={confirm}>
              {titles[kind]}
            </Button>
          </>
        )
      }
    >
      {!token && kind === 'revoke' && (
        <p>
          <strong>{name}</strong>’s pass will be rejected at the door. You can restore it later.
        </p>
      )}
      {!token && kind === 'restore' && (
        <p>
          <strong>{name}</strong>’s pass will be valid for entry again.
        </p>
      )}
      {!token && kind === 'reissue' && (
        <p>
          A new pass will be created for <strong>{name}</strong>. Their current QR code and pass link{' '}
          <strong>stop working immediately</strong>. Use this when an attendee lost their pass. Verify the
          attendee’s identity before handing over the new pass.
        </p>
      )}
      {token && url && (
        <div className="space-y-3">
          <Alert tone="ok">
            New pass created for {name}. It is shown only once — share it with the attendee now.
          </Alert>
          <QrImage
            dataUrl={qr}
            alt={`New pass QR for ${name}`}
            className="mx-auto max-w-60 ring-1 ring-line-soft"
          />
          <p className="text-center font-mono text-sm">{formatPassToken(token)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <CopyButton text={url} label="Copy pass link" />
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-brand hover:underline"
            >
              Open pass ↗
            </a>
          </div>
          <p className="text-center text-xs text-fg-subtle">{event.name}</p>
        </div>
      )}
      {error && (
        <Alert tone="bad" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  )
}
