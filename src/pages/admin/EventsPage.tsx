import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { getEventSummaries } from '../../lib/api'
import { formatEventDate } from '../../lib/datetime'
import { registrationUrl } from '../../lib/passToken'
import { usePolling } from '../../lib/usePolling'
import type { EventSummary } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { CopyButton } from '../../components/CopyButton'
import { EventStatusBadge } from '../../components/StatusBadge'
import { Alert, Badge, ButtonLink, Card, PageSpinner, Select } from '../../components/ui'

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
            <Select
              aria-label="Filter events"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              className="min-h-11 w-auto py-2"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </Select>
            {isAdmin && <ButtonLink to="/admin/events/new">Create event</ButtonLink>}
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
          <p className="mt-1 text-ink-600">
            {isAdmin
              ? 'Create your first event to get a registration link and QR code.'
              : 'You are not assigned to any events yet. Ask an organizer to add you.'}
          </p>
          {isAdmin && (
            <ButtonLink to="/admin/events/new" className="mt-4">
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
          <p className="text-sm text-ink-600">
            {formatEventDate(event.starts_at, event.ends_at, event.timezone)}
          </p>
          {event.location && <p className="text-sm text-ink-500">{event.location}</p>}
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
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
        <div className="h-full rounded-full bg-ok-600" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {canManage && (
          <ButtonLink to={`/admin/events/${event.id}`} variant="secondary" size="sm">
            Manage
          </ButtonLink>
        )}
        {canManage && event.status !== 'draft' && event.status !== 'archived' && (
          <CopyButton text={registrationUrl(event.slug)} label="Copy link" size="sm" />
        )}
        {event.status !== 'archived' && (
          <ButtonLink to={`/scan/${event.id}`} size="sm">
            Scan
          </ButtonLink>
        )}
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-ink-50 px-2 py-2">
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd className="text-xl font-bold tabular-nums">{value}</dd>
    </div>
  )
}
