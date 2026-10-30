import { Check, Download, ExternalLink, QrCode, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { listAdmissionLogs, registrationNames } from '../../../lib/api'
import { usePolling } from '../../../lib/usePolling'
import { registrationUrl } from '../../../lib/passToken'
import { dataUrlToBlob, renderPassImage, safeFilename, saveImage } from '../../../lib/qr'
import { dateParts, formatEventDate, formatTime } from '../../../lib/datetime'
import type { AdmissionLog, EventRow, EventSummary } from '../../../lib/types'
import { CopyButton, ShareButton } from '../../../components/CopyButton'
import { QrImage } from '../../../components/QrImage'
import { useQrDataUrl } from '../../../components/useQrDataUrl'
import { Alert, Button, Card, cx } from '../../../components/ui'

export function OverviewTab({ event, summary }: { event: EventRow; summary: EventSummary | null }) {
  const when = dateParts(event.starts_at, event.timezone)
  const url = registrationUrl(event.slug)
  const qr = useQrDataUrl(url, 1024)
  const [busy, setBusy] = useState(false)
  const shareable = event.status === 'published' || event.status === 'closed'

  async function downloadQr() {
    if (!qr) return
    setBusy(true)
    try {
      const blob = await renderPassImage({
        qr,
        title: event.name,
        subtitle: 'Scan to register',
        lines: [
          formatEventDate(event.starts_at, event.ends_at, event.timezone),
          ...(event.location ? [event.location] : []),
        ],
        footer: url.replace(/^https?:\/\//, ''),
      })
      await saveImage(blob, `registration-${safeFilename(event.slug)}.png`)
    } finally {
      setBusy(false)
    }
  }

  async function downloadPlainQr() {
    if (!qr) return
    const blob = dataUrlToBlob(qr)
    await saveImage(blob, `registration-qr-${safeFilename(event.slug)}.png`)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-4">
          <QrImage
            dataUrl={qr}
            alt={`Registration QR code for ${event.name}`}
            className="size-24 max-w-24 shrink-0 p-1.5 ring-1 ring-line-soft"
          />
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold">Invite guests</h2>
            <p className="mt-0.5 text-sm text-fg-subtle">
              Send the link, or print the QR poster for the entrance. Guests register in English or Arabic.
            </p>
          </div>
        </div>
        {!shareable && (
          <Alert tone="warn" title={event.status === 'draft' ? 'Not published yet' : 'Archived'}>
            {event.status === 'draft'
              ? 'Attendees cannot open the link until the event is published.'
              : 'Archived events are hidden from the public.'}
          </Alert>
        )}
        <div
          className="rounded-control bg-surface-sunk px-3 py-2.5 font-mono text-sm break-all ring-1 ring-line"
          data-testid="registration-url"
        >
          {url}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ShareButton
            url={url}
            title={event.name}
            text={`You're invited to ${event.name} (${when.date}, ${when.time}${event.location ? `, ${event.location}` : ''}). Register here:`}
            label="Share invite"
            variant="primary"
          />
          <CopyButton text={url} label="Copy link" />
          <Button variant="secondary" icon={Download} onClick={downloadQr} loading={busy} disabled={!qr}>
            QR poster
          </Button>
          <Button variant="ghost" icon={QrCode} onClick={downloadPlainQr} disabled={!qr}>
            QR only
          </Button>
        </div>
        <a
          className="inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open the registration page <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </Card>

      <LatestAtTheDoor event={event} summary={summary} />
    </div>
  )
}

/** The last few scans, so organizers see the door at a glance. */
function LatestAtTheDoor({ event, summary }: { event: EventRow; summary: EventSummary | null }) {
  const [logs, setLogs] = useState<AdmissionLog[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const load = useCallback(() => {
    listAdmissionLogs(event.id, 6)
      .then(async (l) => {
        const ids = [...new Set(l.map((x) => x.registration_id).filter((x): x is string => Boolean(x)))]
        setNames(await registrationNames(ids))
        setLogs(l)
      })
      .catch(() => setLogs([]))
  }, [event.id])
  useEffect(load, [load, summary?.checked_in_count])
  usePolling(load, 15_000)

  return (
    <Card className="p-5">
      <h2 className="text-xs font-extrabold tracking-[0.12em] text-fg-subtle uppercase">
        Latest at the door
      </h2>
      {logs && logs.length === 0 && (
        <p className="mt-3 text-sm text-fg-subtle">
          No scans yet. Check-ins appear here as soon as the door opens.
        </p>
      )}
      <ul className="mt-2 divide-y divide-line-soft">
        {logs?.map((l) => {
          const ok = l.result === 'admitted'
          const name = (l.registration_id && names.get(l.registration_id)) || 'Unknown pass'
          return (
            <li key={l.id} className="flex items-center gap-3 py-2.5">
              <span
                className={cx(
                  'flex size-8 shrink-0 items-center justify-center rounded-full',
                  ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg',
                )}
                aria-hidden="true"
              >
                {ok ? <Check className="size-4" strokeWidth={3} /> : <X className="size-4" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-bold">
                {name}
                {!ok && <span className="font-medium text-danger-fg"> · {l.result.replace('_', ' ')}</span>}
              </span>
              <span className="text-xs text-fg-subtle tabular-nums">
                {formatTime(l.attempted_at, event.timezone)}
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
