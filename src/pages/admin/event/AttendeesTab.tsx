import { useCallback, useEffect, useState } from 'react'
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
import { usePolling } from '../../../lib/usePolling'
import type { EventRow, Registration, RegistrationStatus } from '../../../lib/types'
import { CopyButton } from '../../../components/CopyButton'
import { Modal } from '../../../components/Modal'
import { QrImage } from '../../../components/QrImage'
import { useQrDataUrl } from '../../../components/useQrDataUrl'
import { RegistrationStatusBadge } from '../../../components/StatusBadge'
import { Alert, Button, Card, Input, Select, Spinner } from '../../../components/ui'

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

  const load = useCallback(() => {
    listRegistrations({ eventId: event.id, search: debounced, status, page, pageSize: PAGE_SIZE })
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [event.id, debounced, status, page])

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name, email or phone"
          aria-label="Search attendees"
          className="max-w-xs flex-1"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
        />
        {/* Wrapper sets the width: the shared control class is w-full. */}
        <div className="w-48 shrink-0">
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
        <div className="flex-1" />
        <Button variant="secondary" onClick={exportCsv} loading={exporting}>
          Export CSV
        </Button>
      </div>

      {error && <Alert tone="bad">{error}</Alert>}

      <Card className="overflow-hidden">
        {!data ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : data.rows.length === 0 ? (
          <p className="p-8 text-center text-ink-500">No attendees match.</p>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-left text-sm md:table">
              <thead className="bg-ink-50 text-xs font-semibold tracking-wide text-ink-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Registered</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Checked in</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.rows.map((r) => (
                  <tr key={r.id} data-testid="attendee-row">
                    <td className="px-4 py-3 font-semibold">
                      {r.first_name} {r.last_name}
                    </td>
                    <td className="max-w-56 px-4 py-3 text-ink-600">
                      <div className="truncate">{r.email ?? (r.phone ? '' : '—')}</div>
                      {r.phone && <div className="truncate tabular-nums">{r.phone}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-ink-600">
                      {formatDateTime(r.registered_at, event.timezone)}
                    </td>
                    <td className="px-4 py-3">
                      <RegistrationStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-ink-600">
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
            <ul className="divide-y divide-ink-100 md:hidden">
              {data.rows.map((r) => (
                <li key={r.id} className="space-y-1 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">
                      {r.first_name} {r.last_name}
                    </p>
                    <RegistrationStatusBadge status={r.status} />
                  </div>
                  {r.email && <p className="truncate text-sm text-ink-600">{r.email}</p>}
                  {r.phone && <p className="truncate text-sm text-ink-600 tabular-nums">{r.phone}</p>}
                  <p className="text-xs text-ink-500">
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
          <span className="text-ink-600">
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
        <p className="text-sm text-ink-500">{data.total} attendees</p>
      )}

      {action && (
        <ActionModal
          event={event}
          reg={action.reg}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={() => {
            load()
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
          <Button variant="ghost" size="sm" onClick={() => onAction('reissue')}>
            Reissue
          </Button>
          <Button variant="ghost" size="sm" className="text-bad-700" onClick={() => onAction('revoke')}>
            Revoke
          </Button>
        </>
      )}
      {reg.status === 'revoked' && (
        <Button variant="ghost" size="sm" onClick={() => onAction('restore')}>
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
      if (kind === 'revoke') await revokeRegistration(reg.id)
      if (kind === 'restore') await restoreRegistration(reg.id)
      if (kind === 'reissue') setToken(await reissuePass(reg.id))
      onDone()
      if (kind !== 'reissue') onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
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
            className="mx-auto max-w-60 ring-1 ring-ink-100"
          />
          <p className="text-center font-mono text-sm">{formatPassToken(token)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <CopyButton text={url} label="Copy pass link" />
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-accent-600 hover:underline"
            >
              Open pass ↗
            </a>
          </div>
          <p className="text-center text-xs text-ink-500">{event.name}</p>
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
