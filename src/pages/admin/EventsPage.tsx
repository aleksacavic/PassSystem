import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { getEventSummaries } from '../../lib/api'
import { formatEventDate } from '../../lib/datetime'
import { registrationUrl } from '../../lib/passToken'
import { usePolling } from '../../lib/usePolling'
import type { EventSummary } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { CopyButton, ShareButton } from '../../components/CopyButton'
import { EventStatusBadge } from '../../components/StatusBadge'
import { Plus, ScanLine, Settings2 } from 'lucide-react'
import { Alert, Badge, ButtonLink, Card, PageSpinner, SegmentedControl } from '../../components/ui'

export default function EventsPage() {
  const { isAdmin } = useAuth()
  const [events, setEvents] = useState<EventSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'active' | 'all' | 'archived'>('active')

  const load = useCallback(() => {
    getEventSummaries()
      .then((e) => {
        setEvents(e)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])
  usePolling(load, 15_000)

  const visible = (events ?? []).filter((e) =>
    filter === 'all' ? true : filter === 'archived' ? e.status === 'archived' : e.status !== 'archived',
  )

  return (
    <div>
      <PageHeader
        title="Events"
        description="Registrations and admissions update automatically."
        actions={
          <>
            <SegmentedControl
              label="Filter events"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
                { value: 'all', label: 'All' },
              ]}
            />
            {isAdmin && (
              <ButtonLink to="/admin/events/new" icon={Plus}>
                Create event
              </ButtonLink>
            )}
          </>
        }
      />
      {error && (
        <Alert tone="bad" className="mb-4">
          {error}
        </Alert>
      )}
      {events === null && !error && <PageSpinner />}
      {events !== null && visible.length === 0 && (
        <Card className="p-8 text-center">
          <h2 className="text-lg font-semibold">No events</h2>
          <p className="mt-1 text-fg-muted">
            {isAdmin
              ? 'Create your first event to get a registration link and QR code.'
              : 'You are not assigned to any events yet. Ask an organizer to add you.'}
          </p>
          {isAdmin && (
            <ButtonLink to="/admin/events/new" icon={Plus} className="mt-4">
              Create event
            </ButtonLink>
          )}
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {visible.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </div>
    </div>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  const canManage = event.my_role === 'admin' || event.my_role === 'organizer'
  const shareable = event.status !== 'draft' && event.status !== 'archived'
  const remaining = Math.max(0, event.registered_count - event.checked_in_count)
  const pct = event.registered_count ? Math.round((event.checked_in_count / event.registered_count) * 100) : 0
  return (
    <Card className="flex flex-col p-5" data-testid="event-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">
            {canManage ? (
              <Link to={`/admin/events/${event.id}`} className="hover:underline">
                {event.name}
              </Link>
            ) : (
              event.name
            )}
          </h2>
          <p className="text-sm text-fg-muted">
            {formatEventDate(event.starts_at, event.ends_at, event.timezone)}
          </p>
          {event.location && <p className="text-sm text-fg-subtle">{event.location}</p>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <EventStatusBadge status={event.status} />
          {event.my_role === 'operator' && <Badge>Operator</Badge>}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Registered" value={event.registered_count} />
        <Stat label="Admitted" value={event.checked_in_count} />
        <Stat label="Remaining" value={remaining} />
      </dl>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {event.status !== 'archived' && (
          <ButtonLink to={`/scan/${event.id}`} size="sm" icon={ScanLine}>
            Scan
          </ButtonLink>
        )}
        {canManage && shareable && (
          <ShareButton
            url={registrationUrl(event.slug)}
            title={event.name}
            text={`Register for ${event.name}:`}
            label="Share invite"
            size="sm"
          />
        )}
        {canManage && shareable && (
          <CopyButton text={registrationUrl(event.slug)} label="Copy link" size="sm" />
        )}
        {canManage && (
          <ButtonLink to={`/admin/events/${event.id}`} variant="secondary" size="sm" icon={Settings2}>
            Manage
          </ButtonLink>
        )}
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control bg-surface-sunk px-2 py-2">
      <dt className="text-xs font-medium text-fg-subtle">{label}</dt>
      <dd className="text-xl font-bold tabular-nums">{value}</dd>
    </div>
  )
}
