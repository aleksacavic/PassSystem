import { useCallback, useEffect, useState } from 'react'
import { listAdmissionLogs, registrationNames } from '../../../lib/api'
import { formatDateTime } from '../../../lib/datetime'
import { usePolling } from '../../../lib/usePolling'
import type { AdmissionLog, AdmissionResult, EventRow } from '../../../lib/types'
import { Alert, Badge, Card, CardHeader, Spinner } from '../../../components/ui'
import { ScanHistory } from './ScanHistory'

const LABELS: Record<AdmissionResult, { label: string; tone: 'ok' | 'bad' | 'warn' }> = {
  admitted: { label: 'Admitted', tone: 'ok' },
  already_used: { label: 'Already used', tone: 'bad' },
  invalid: { label: 'Invalid', tone: 'bad' },
  revoked: { label: 'Revoked', tone: 'bad' },
  wrong_event: { label: 'Wrong event', tone: 'warn' },
}

export function ActivityTab({ event }: { event: EventRow }) {
  const [logs, setLogs] = useState<AdmissionLog[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    listAdmissionLogs(event.id, 100)
      .then(async (l) => {
        const ids = [...new Set(l.map((x) => x.registration_id).filter((x): x is string => Boolean(x)))]
        const n = await registrationNames(ids)
        setNames(n)
        setLogs(l)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [event.id])

  useEffect(load, [load])
  usePolling(load, 10_000)

  return (
    <div className="space-y-4">
      <ScanHistory event={event} />
      <Card>
        <CardHeader
          title="Scan activity"
          description="Last 100 server-validated scan attempts, newest first."
        />
        {error && (
          <Alert tone="bad" className="m-4">
            {error}
          </Alert>
        )}
        {!logs ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : logs.length === 0 ? (
          <p className="p-6 text-center text-fg-subtle">No scans yet.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {logs.map((l) => {
              const meta = LABELS[l.result]
              const name = l.registration_id ? names.get(l.registration_id) : null
              return (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {name ?? (l.result === 'wrong_event' ? 'Pass from another event' : 'Unknown pass')}
                    </p>
                    <p className="text-xs text-fg-subtle">{formatDateTime(l.attempted_at, event.timezone)}</p>
                  </div>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
