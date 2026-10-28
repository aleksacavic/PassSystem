import { useState } from 'react'
import { registrationUrl } from '../../../lib/passToken'
import { dataUrlToBlob, renderPassImage, safeFilename, saveImage } from '../../../lib/qr'
import { formatEventDate } from '../../../lib/datetime'
import type { EventRow, EventSummary } from '../../../lib/types'
import { CopyButton } from '../../../components/CopyButton'
import { QrImage } from '../../../components/QrImage'
import { useQrDataUrl } from '../../../components/useQrDataUrl'
import { Alert, Button, Card, CardHeader, StatCard } from '../../../components/ui'

export function OverviewTab({ event, summary }: { event: EventRow; summary: EventSummary | null }) {
  const registered = summary?.registered_count ?? 0
  const checkedIn = summary?.checked_in_count ?? 0
  const remaining = Math.max(0, registered - checkedIn)
  const pct = registered ? Math.round((checkedIn / registered) * 100) : 0
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
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="stats">
        <StatCard
          label="Registrations"
          value={registered}
          hint={event.max_attendees ? `of ${event.max_attendees} max` : undefined}
        />
        <StatCard label="Checked in" value={checkedIn} tone="ok" />
        <StatCard label="Not yet checked in" value={remaining} />
        <StatCard
          label="Admission rate"
          value={`${pct}%`}
          hint={summary?.revoked_count ? `${summary.revoked_count} revoked` : undefined}
        />
      </div>
      <div
        className="h-3 overflow-hidden rounded-full bg-ink-200"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Admission progress"
      >
        <div className="h-full rounded-full bg-ok-600 transition-[width]" style={{ width: `${pct}%` }} />
      </div>

      <Card>
        <CardHeader
          title="Share registration"
          description="Attendees open this link or scan the QR code to register."
        />
        <div className="grid gap-5 p-5 sm:grid-cols-[220px_1fr]">
          <QrImage
            dataUrl={qr}
            alt={`Registration QR code for ${event.name}`}
            className="mx-auto w-full max-w-[220px] ring-1 ring-ink-100"
          />
          <div className="min-w-0 space-y-3">
            {!shareable && (
              <Alert tone="warn" title={event.status === 'draft' ? 'Not published yet' : 'Archived'}>
                {event.status === 'draft'
                  ? 'Attendees cannot open the link until the event is published.'
                  : 'Archived events are hidden from the public.'}
              </Alert>
            )}
            <div
              className="rounded-xl bg-ink-50 px-3 py-2.5 font-mono text-sm break-all ring-1 ring-ink-200"
              data-testid="registration-url"
            >
              {url}
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={url} label="Copy link" />
              <Button variant="secondary" onClick={downloadQr} loading={busy} disabled={!qr}>
                Download QR poster
              </Button>
              <Button variant="ghost" onClick={downloadPlainQr} disabled={!qr}>
                QR only (PNG)
              </Button>
              <a
                className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-accent-600 hover:underline"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                Open page ↗
              </a>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
