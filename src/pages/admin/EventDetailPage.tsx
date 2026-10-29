import { ChevronLeft, Pencil, ScanLine, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { getEvent, getEventSummaries, updateEvent } from '../../lib/api'
import { formatEventDate } from '../../lib/datetime'
import { usePolling } from '../../lib/usePolling'
import type { EventRow, EventSummary } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { EventStatusBadge } from '../../components/StatusBadge'
import { Alert, Button, ButtonLink, PageSpinner, buttonClass, cx } from '../../components/ui'
import { OverviewTab } from './event/OverviewTab'
import { AttendeesTab } from './event/AttendeesTab'
import { StaffTab } from './event/StaffTab'
import { ActivityTab } from './event/ActivityTab'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'attendees', label: 'Attendees' },
  { key: 'staff', label: 'Staff' },
  { key: 'activity', label: 'Activity' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function EventDetailPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview') as TabKey
  const [event, setEvent] = useState<EventRow | null>(null)
  const [summary, setSummary] = useState<EventSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  const loadSummary = useCallback(() => {
    getEventSummaries(id)
      .then((s) => setSummary(s[0] ?? null))
      .catch(() => undefined)
  }, [id])

  useEffect(() => {
    getEvent(id)
      .then(setEvent)
      .catch((e: Error) => setError(e.message))
    loadSummary()
  }, [id, loadSummary])

  usePolling(loadSummary, 10_000)

  if (error) return <Alert tone="bad">{error}</Alert>
  if (!event) return <PageSpinner />

  const role = summary?.my_role
  if (role === 'operator') {
    return (
      <div>
        <PageHeader title={event.name} />
        <Alert tone="info" title="Operator access">
          You can scan passes for this event. Attendee management is available to organizers.
        </Alert>
        <ButtonLink to={`/scan/${event.id}`} className="mt-4">
          Open scanner
        </ButtonLink>
      </div>
    )
  }

  async function publish() {
    if (!event) return
    setPublishing(true)
    try {
      setEvent(await updateEvent(event.id, { status: 'published' }, { status: event.status }))
      loadSummary()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const registered = summary?.registered_count ?? 0
  const checkedIn = summary?.checked_in_count ?? 0
  const pct = registered ? Math.round((checkedIn / registered) * 100) : 0
  const placesLeft = event.max_attendees != null ? Math.max(0, event.max_attendees - registered) : null

  return (
    <div className="space-y-5">
      <section className="band-pattern space-y-4 rounded-card bg-primary p-5 text-on-brand shadow-raised">
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/admin"
            className="-ms-1 inline-flex min-h-10 items-center gap-1 text-sm font-bold text-on-brand-muted hover:text-on-brand"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Events
          </Link>
          <ButtonLink
            to={`/admin/events/${event.id}/edit`}
            variant="ghost"
            size="sm"
            icon={Pencil}
            className="text-on-brand ring-1 ring-on-brand/30 ring-inset hover:bg-on-brand/10 hover:text-on-brand"
          >
            Edit
          </ButtonLink>
        </div>
        <div className="space-y-1.5">
          <EventStatusBadge status={event.status} />
          <h1 className="text-[1.75rem] leading-tight font-extrabold tracking-tight break-words">
            {event.name}
          </h1>
          <p className="text-sm text-on-brand-muted">
            {formatEventDate(event.starts_at, event.ends_at, event.timezone)}
            {event.location ? ` · ${event.location}` : ''}
          </p>
        </div>
        <dl className="grid grid-cols-4 rounded-control bg-on-brand/10 py-3" data-testid="stats">
          <HeaderStat label="Checked in" value={checkedIn} />
          <HeaderStat label="Still to come" value={Math.max(0, registered - checkedIn)} />
          <HeaderStat label="Registered" value={registered} />
          <HeaderStat label={placesLeft != null ? 'Places left' : 'Rate'} value={placesLeft ?? `${pct}%`} />
        </dl>
        <div className="flex flex-wrap gap-2">
          {event.status === 'draft' && (
            <Button variant="success" icon={Send} onClick={publish} loading={publishing}>
              Publish
            </Button>
          )}
          {event.status !== 'archived' && (
            <Link
              to={`/scan/${event.id}`}
              className={buttonClass(
                'secondary',
                'lg',
                'flex-1 bg-on-brand text-primary ring-0 hover:bg-on-brand/90',
              )}
            >
              <ScanLine aria-hidden="true" />
              Open scanner
            </Link>
          )}
        </div>
      </section>

      <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Event sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === 'overview' ? {} : { tab: t.key }, { replace: true })}
            className={cx(
              'min-h-9 rounded-pill px-3.5 text-sm font-bold whitespace-nowrap transition-colors',
              tab === t.key ? 'bg-fg text-canvas' : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab event={event} summary={summary} />}
      {tab === 'attendees' && <AttendeesTab event={event} onChanged={loadSummary} />}
      {tab === 'staff' && <StaffTab event={event} isAdmin={role === 'admin'} />}
      {tab === 'activity' && <ActivityTab event={event} />}
    </div>
  )
}

function HeaderStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col-reverse items-center gap-0.5 border-e border-on-brand/15 px-1 text-center last:border-e-0">
      <dt className="text-[11px] leading-tight font-bold text-on-brand-muted">{label}</dt>
      <dd className="text-2xl leading-none font-extrabold tabular-nums">{value}</dd>
    </div>
  )
}
