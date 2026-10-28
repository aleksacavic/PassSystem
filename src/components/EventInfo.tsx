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
      <p className="flex items-start gap-2 text-[15px] text-ink-700">
        <CalendarIcon />
        <span>
          {formatEventDate(event.starts_at, event.ends_at, event.timezone)}{' '}
          <span className="text-ink-500">({zoneLabel(event.starts_at, event.timezone)})</span>
        </span>
      </p>
      {event.location && (
        <p className="flex items-start gap-2 text-[15px] text-ink-700">
          <PinIcon />
          <span className="break-words">{event.location}</span>
        </p>
      )}
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="mt-0.5 size-4 shrink-0 text-ink-400"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 2a1 1 0 0 1 1 1v1h6V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1Zm10 6H4v8h12V8Z" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="mt-0.5 size-4 shrink-0 text-ink-400"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M10 2a6 6 0 0 0-6 6c0 4.2 5.1 9.4 5.3 9.6a1 1 0 0 0 1.4 0C10.9 17.4 16 12.2 16 8a6 6 0 0 0-6-6Zm0 8.5A2.5 2.5 0 1 1 10 5.5a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  )
}
