import { listAdmittedScanTimes } from '../../../lib/api'
import type { EventRow } from '../../../lib/types'
import { HistoryPanel } from './HistoryPanel'

/** When people were let in, on the Scan activity tab. */
export function ScanHistory({ event }: { event: EventRow }) {
  return (
    <HistoryPanel
      title="Check-in history"
      subtitle="When people were let in over time"
      timeZone={event.timezone}
      load={() => listAdmittedScanTimes(event.id)}
      noun={['check-in', 'check-ins']}
      empty="No check-ins yet."
      footnote="Counts admitted scans only; refused or repeated scans are in the list below."
    />
  )
}
