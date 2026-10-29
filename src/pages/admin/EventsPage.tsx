import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { getEventSummaries, updateEvent } from '../../lib/api'
import { registrationUrl } from '../../lib/passToken'
import { usePolling } from '../../lib/usePolling'
import type { EventSummary } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { copyText } from '../../lib/clipboard'
import { dateParts } from '../../lib/datetime'
import { ShareButton } from '../../components/CopyButton'
import { DateTile } from '../../components/DateTile'
import { Archive, ArchiveRestore, Link2, Plus, ScanLine, Settings2 } from 'lucide-react'
import { Alert, Badge, ButtonLink, Card, Menu, PageSpinner, SegmentedControl, cx } from '../../components/ui'

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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {visible.map((e) => (
          <EventCard key={e.id} event={e} onChanged={load} onError={setError} />
        ))}
      </div>
    </div>
  )
}

type Phase = { label: string; tone: 'live' | 'open' | 'quiet' | 'draft' }

/** What an organizer most needs to know about the event right now. */
function phaseOf(event: EventSummary, now = Date.now()): Phase {
  if (event.status === 'draft') return { label: 'Draft · not published', tone: 'draft' }
  if (event.status === 'archived') return { label: 'Archived', tone: 'quiet' }
  const start = Date.parse(event.starts_at)
  const end = event.ends_at ? Date.parse(event.ends_at) : start + 12 * 3600_000
  if (now >= start - 2 * 3600_000 && now <= end) return { label: 'Live · doors open', tone: 'live' }
  if (now > end) return { label: 'Ended', tone: 'quiet' }
  if (event.status === 'closed') return { label: 'Registration closed', tone: 'quiet' }
  return { label: 'Registration open', tone: 'open' }
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const pct = total ? Math.min(1, done / total) : 0
  return (
    <div className="relative size-14 shrink-0" role="img" aria-label={`${done} of ${total} checked in`}>
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" className="stroke-surface-muted" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          className="stroke-success transition-[stroke-dasharray]"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-sm font-extrabold tabular-nums">
          {done}/{total}
        </span>
        <span className="mt-0.5 text-[9px] font-bold text-fg-subtle">IN</span>
      </div>
    </div>
  )
}

function EventCard({
  event,
  onChanged,
  onError,
}: {
  event: EventSummary
  onChanged: () => void
  onError: (message: string) => void
}) {
  const canManage = event.my_role === 'admin' || event.my_role === 'organizer'
  const archived = event.status === 'archived'

  async function setArchived(archive: boolean) {
    const question = archive
      ? `Archive "${event.name}"? Its registration page closes, existing passes show as not active and can no longer be scanned, and it moves to the Archived list. Registrations and scan history are kept, and you can restore it.`
      : `Restore "${event.name}" as a draft? Existing passes can be scanned again right away; the registration page stays closed until you publish it.`
    if (!window.confirm(question)) return
    try {
      await updateEvent(event.id, { status: archive ? 'archived' : 'draft' }, { status: event.status })
      onChanged()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const shareable = event.status !== 'draft' && event.status !== 'archived'
  const phase = phaseOf(event)
  const when = dateParts(event.starts_at, event.timezone)
  const url = registrationUrl(event.slug)
  const menu = [
    ...(shareable
      ? [{ label: 'Copy registration link', icon: Link2, onSelect: () => void copyText(url) }]
      : []),
    { label: 'Manage event', icon: Settings2, to: `/admin/events/${event.id}` },
    archived
      ? { label: 'Restore as draft', icon: ArchiveRestore, onSelect: () => void setArchived(false) }
      : { label: 'Archive event', icon: Archive, onSelect: () => void setArchived(true) },
  ]
  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4" data-testid="event-card">
      <div className="flex items-center gap-3.5">
        <DateTile
          iso={event.starts_at}
          timeZone={event.timezone}
          tone={phase.tone === 'live' || phase.tone === 'open' ? 'brand' : 'muted'}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cx(
              'flex items-center gap-1.5 text-xs font-bold',
              phase.tone === 'live' && 'text-success',
              phase.tone === 'open' && 'text-brand',
              phase.tone === 'draft' && 'text-warning-fg',
              phase.tone === 'quiet' && 'text-fg-subtle',
            )}
          >
            {phase.tone === 'live' && <span className="size-2 rounded-full bg-success" aria-hidden="true" />}
            {phase.label}
            {event.my_role === 'operator' && <Badge className="ms-1">Operator</Badge>}
          </p>
          <h2 className="mt-0.5 text-lg leading-snug font-extrabold tracking-tight break-words">
            {canManage ? (
              <Link to={`/admin/events/${event.id}`} className="hover:underline">
                {event.name}
              </Link>
            ) : (
              event.name
            )}
          </h2>
          <p className="truncate text-sm text-fg-subtle">
            {when.time}
            {event.location ? ` · ${event.location}` : ''}
            {event.max_attendees ? ` · ${event.registered_count}/${event.max_attendees} registered` : ''}
          </p>
        </div>
        <ProgressRing done={event.checked_in_count} total={event.registered_count} />
      </div>
      <div className="flex gap-2">
        {event.status !== 'archived' && (
          <ButtonLink to={`/scan/${event.id}`} icon={ScanLine} className="flex-1">
            Scan
          </ButtonLink>
        )}
        {canManage && shareable && (
          <ShareButton
            url={url}
            title={event.name}
            text={`You're invited to ${event.name} (${when.date}, ${when.time}). Register here:`}
            label="Share invite"
            iconOnly
          />
        )}
        {canManage && <Menu label={`More actions for ${event.name}`} items={menu} />}
      </div>
    </Card>
  )
}
