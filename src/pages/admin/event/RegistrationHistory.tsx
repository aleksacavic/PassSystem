import { listAllRegistrations } from '../../../lib/api'
import type { EventRow } from '../../../lib/types'
import { HistoryPanel } from './HistoryPanel'

/** When people registered, on the Attendees tab. */
export function RegistrationHistory({ event }: { event: EventRow }) {
  return (
    <HistoryPanel
      title="Registration history"
      subtitle="When people registered over time"
      timeZone={event.timezone}
      load={async () => (await listAllRegistrations(event.id)).map((r) => r.registered_at)}
      noun={['registration', 'registrations']}
      empty="No registrations yet."
      footnote="Includes passes that were later revoked."
    />
  )
}
