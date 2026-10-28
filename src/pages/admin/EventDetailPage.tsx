import { Pencil, ScanLine, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { getEvent, getEventSummaries, updateEvent } from '../../lib/api'
import { formatEventDate } from '../../lib/datetime'
import { usePolling } from '../../lib/usePolling'
import type { EventRow, EventSummary } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { EventStatusBadge } from '../../components/StatusBadge'
import { Alert, Button, ButtonLink, PageSpinner, cx } from '../../components/ui'
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
      setEvent(await updateEvent(event.id, { status: 'published' }))
      loadSummary()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div>
      <PageHeader
        back={
          <Link to="/admin" className="text-sm font-semibold text-brand hover:underline">
            ← Events
          </Link>
        }
        title={event.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EventStatusBadge status={event.status} />
            <span>{formatEventDate(event.starts_at, event.ends_at, event.timezone)}</span>
            {event.location && <span className="text-fg-subtle">· {event.location}</span>}
          </span>
        }
        actions={
          <>
            {event.status === 'draft' && (
              <Button variant="success" icon={Send} onClick={publish} loading={publishing}>
                Publish
              </Button>
            )}
            <ButtonLink to={`/admin/events/${event.id}/edit`} variant="secondary" icon={Pencil}>
              Edit
            </ButtonLink>
            {event.status !== 'archived' && (
              <ButtonLink to={`/scan/${event.id}`} icon={ScanLine}>
                Scan
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === 'overview' ? {} : { tab: t.key }, { replace: true })}
            className={cx(
              '-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold whitespace-nowrap',
              tab === t.key ? 'border-fg text-fg' : 'border-transparent text-fg-subtle hover:text-fg',
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
