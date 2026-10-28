import { CalendarDays, MapPin } from 'lucide-react'
import { formatEventDate, zoneLabel } from '../lib/datetime'
import type { PublicEvent } from '../lib/types'

export function EventInfo({ event, compact }: { event: PublicEvent; compact?: boolean }) {
  return (
    <div className="space-y-1.5">
      <h1
        className={
          compact ? 'text-xl font-bold tracking-tight' : 'text-2xl font-bold tracking-tight sm:text-3xl'
        }
      >
        {event.name}
      </h1>
      <p className="flex items-start gap-2 text-[15px] text-fg">
        <CalendarIcon />
        <span>
          {formatEventDate(event.starts_at, event.ends_at, event.timezone)}{' '}
          <span className="text-fg-subtle">({zoneLabel(event.starts_at, event.timezone)})</span>
        </span>
      </p>
      {event.location && (
        <p className="flex items-start gap-2 text-[15px] text-fg">
          <PinIcon />
          <span className="break-words">{event.location}</span>
        </p>
      )}
    </div>
  )
}

function CalendarIcon() {
  return <CalendarDays className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden="true" />
}

function PinIcon() {
  return <MapPin className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden="true" />
}
