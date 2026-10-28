import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  Flashlight,
  FlashlightOff,
  SwitchCamera,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { admitPass, getEventSummaries, type AdmitOutcome } from '../../lib/api'
import { formatEventDate, formatTime } from '../../lib/datetime'
import { extractPassToken } from '../../lib/passToken'
import { randomUuid } from '../../lib/random'
import { usePolling } from '../../lib/usePolling'
import type { EventSummary } from '../../lib/types'
import { ScanGate } from '../../scanner/scanGate'
import { feedback, unlockAudio } from '../../scanner/feedback'
import { useCameraScanner } from '../../scanner/useCameraScanner'
import { useWakeLock } from '../../scanner/useWakeLock'
import { Alert, Button, ButtonLink, Card, Input, PageSpinner, Spinner, cx } from '../../components/ui'
import { EventStatusBadge } from '../../components/StatusBadge'

export default function ScanPage() {
  const { eventId } = useParams()
  // key: a different event gets a fresh scanner (no stale header, gate or history).
  return eventId ? <Scanner key={eventId} eventId={eventId} /> : <EventPicker />
}

/* -------------------------------------------------------------- event list */

function EventPicker() {
  const [events, setEvents] = useState<EventSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getEventSummaries()
      .then((e) => setEvents(e.filter((x) => x.status !== 'archived')))
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Scan passes</h1>
      <p className="mb-5 text-fg-muted">Select the event you are admitting people to.</p>
      {error && <Alert tone="bad">{error}</Alert>}
      {!events && !error && <PageSpinner />}
      {events?.length === 0 && (
        <Card className="p-6 text-center text-fg-muted">You are not assigned to any active events.</Card>
      )}
      <div className="space-y-3">
        {events?.map((e) => (
          <Link
            key={e.id}
            to={`/scan/${e.id}`}
            className="block rounded-card bg-surface p-4 shadow-card ring-1 ring-line/70 hover:ring-line-strong"
            data-testid="scan-event-option"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-lg font-semibold">{e.name}</p>
              <EventStatusBadge status={e.status} />
            </div>
            <p className="text-sm text-fg-muted">{formatEventDate(e.starts_at, e.ends_at, e.timezone)}</p>
            <p className="mt-1 text-sm text-fg-subtle">
              {e.checked_in_count} of {e.registered_count} admitted
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- scanner */

type View =
  | { kind: 'ready' }
  | { kind: 'checking' }
  | { kind: 'outcome'; outcome: AdmitOutcome; token: string; attemptId: string; at: number }
  | { kind: 'not_a_pass'; at: number }

interface HistoryItem {
  id: number
  name: string
  label: string
  tone: 'ok' | 'bad' | 'warn'
  time: string
}

const RESULT_TEXT = {
  admitted: 'ADMITTED',
  already_used: 'ALREADY USED',
  invalid: 'INVALID PASS',
  revoked: 'REVOKED',
  wrong_event: 'WRONG EVENT',
} as const

function toneOf(outcome: AdmitOutcome): 'ok' | 'bad' | 'warn' {
  if (outcome.kind === 'error') return 'warn'
  if (outcome.kind === 'denied') return 'bad'
  return outcome.response.result === 'admitted' ? 'ok' : 'bad'
}

function Scanner({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<EventSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'ready' })
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [soundOn, setSoundOn] = useState(true)
  const gate = useRef(new ScanGate(3000))
  const historyId = useRef(0)
  const soundRef = useRef(soundOn)
  useEffect(() => {
    soundRef.current = soundOn
  }, [soundOn])

  const refreshEvent = useCallback(() => {
    getEventSummaries(eventId)
      .then((s) => {
        if (s[0]) setEvent(s[0])
        else setLoadError('Event not found, or you are not assigned to it.')
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [eventId])

  useEffect(refreshEvent, [refreshEvent])
  // Other doors admit people too: keep the live count current.
  usePolling(refreshEvent, 15_000)

  const submit = useCallback(
    // attemptId identifies one scan of one credential. Retry reuses it, so a
    // retry after a timeout returns the server's original result.
    async (token: string, attemptId: string) => {
      const now = Date.now()
      gate.current.begin(token, now)
      setView({ kind: 'checking' })
      const outcome = await admitPass(eventId, token, attemptId)
      gate.current.end(token, Date.now())
      const tone = toneOf(outcome)
      feedback(tone, soundRef.current)
      setView({ kind: 'outcome', outcome, token, attemptId, at: Date.now() })
      const name =
        outcome.kind === 'response' && outcome.response.attendee
          ? `${outcome.response.attendee.first_name} ${outcome.response.attendee.last_name}`
          : outcome.kind === 'response'
            ? outcome.response.result === 'wrong_event'
              ? 'Pass for another event'
              : 'Unknown pass'
            : 'Not verified'
      const label =
        outcome.kind === 'response'
          ? RESULT_TEXT[outcome.response.result]
          : outcome.kind === 'denied'
            ? 'NOT ALLOWED'
            : 'NO RESPONSE'
      setHistory((h) =>
        [
          { id: ++historyId.current, name, label, tone, time: formatTime(new Date().toISOString()) },
          ...h,
        ].slice(0, 12),
      )
      if (outcome.kind === 'response' && outcome.response.result === 'admitted') refreshEvent()
    },
    [eventId, refreshEvent],
  )

  const onDetect = useCallback(
    (raw: string) => {
      const token = extractPassToken(raw)
      const key = token ?? `raw:${raw}`
      if (!gate.current.accept(key, Date.now())) return
      if (!token) {
        // Not a PassSystem credential: nothing to validate, never an admission.
        gate.current.end(key, Date.now())
        feedback('bad', soundRef.current)
        setView({ kind: 'not_a_pass', at: Date.now() })
        return
      }
      void submit(token, randomUuid())
    },
    [submit],
  )

  const {
    videoRef,
    status: cameraStatus,
    error: cameraError,
    start: startCamera,
    stop: stopCamera,
    torchSupported,
    torchOn,
    toggleTorch,
    cameraCount,
    switchCamera,
  } = useCameraScanner({ onDetect })
  useWakeLock(cameraStatus === 'running')

  // Return to the live camera view automatically. Amber results stay until the
  // operator retries or dismisses, because the pass has NOT been verified.
  useEffect(() => {
    if (view.kind !== 'outcome' && view.kind !== 'not_a_pass') return
    if (view.kind === 'outcome' && view.outcome.kind === 'error') return
    const ok = view.kind === 'outcome' && toneOf(view.outcome) === 'ok'
    const t = window.setTimeout(() => setView({ kind: 'ready' }), ok ? 2500 : 5000)
    return () => window.clearTimeout(t)
  }, [view])

  function onManualSubmit(e: FormEvent) {
    e.preventDefault()
    setManualError(null)
    const token = extractPassToken(manual)
    if (!token) {
      setManualError('That does not look like a pass code (24 letters/digits).')
      return
    }
    if (gate.current.inFlight) return
    gate.current.reset()
    setManual('')
    void submit(token, randomUuid())
  }

  function retry() {
    if (view.kind !== 'outcome' || gate.current.inFlight) return
    gate.current.reset()
    void submit(view.token, view.attemptId)
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <Alert tone="bad">{loadError}</Alert>
        <ButtonLink to="/scan" variant="secondary">
          Choose another event
        </ButtonLink>
      </div>
    )
  }
  if (!event) return <PageSpinner />

  const running = cameraStatus === 'running'
  const starting = cameraStatus === 'starting'
  const remaining = Math.max(0, event.registered_count - event.checked_in_count)
  const pct = event.registered_count ? Math.round((event.checked_in_count / event.registered_count) * 100) : 0

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {/* Persistent event context with the live count */}
      <div className="space-y-3 rounded-card bg-surface p-4 ring-1 ring-line-soft" data-testid="scan-event">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold tracking-[0.14em] text-fg-subtle uppercase">Scanning for</p>
            <p className="truncate text-lg font-extrabold">{event.name}</p>
          </div>
          <Link
            to="/scan"
            className="shrink-0 rounded-control px-3 py-2 text-sm font-semibold text-fg-muted ring-1 ring-line hover:bg-surface-muted"
          >
            Change
          </Link>
        </div>
        <div
          className="flex items-center gap-3"
          aria-label={`${event.checked_in_count} of ${event.registered_count} checked in`}
        >
          <p className="shrink-0 tabular-nums">
            <span className="text-3xl leading-none font-extrabold">{event.checked_in_count}</span>
            <span className="ms-1 text-base font-bold text-fg-subtle">/ {event.registered_count} in</span>
          </p>
          <div className="h-2 flex-1 overflow-hidden rounded-pill bg-surface-strong" aria-hidden="true">
            <div
              className="h-full rounded-pill bg-success-bright transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="shrink-0 text-xs font-bold text-fg-subtle">{remaining} to come</p>
        </div>
      </div>

      {event.status === 'archived' && (
        <Alert tone="warn">This event is archived. Scanning is disabled.</Alert>
      )}

      {/* Camera */}
      <div className="relative overflow-hidden rounded-[1.75rem] bg-camera" style={{ aspectRatio: '1 / 1' }}>
        <video
          ref={videoRef}
          className="absolute inset-0 size-full object-cover"
          muted
          playsInline
          autoPlay
          aria-label="Camera preview"
        />
        {running && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden="true"
          >
            <div className="size-[68%] rounded-3xl border-4 border-camera-frame shadow-camera-mask" />
          </div>
        )}
        {!running && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-on-inverse">
            {starting ? (
              <>
                <Spinner className="size-8" />
                <p>Starting camera…</p>
              </>
            ) : (
              <>
                {cameraError ? (
                  <p className="max-w-xs text-sm text-on-inverse-soft">{cameraError}</p>
                ) : (
                  <p className="text-on-inverse-soft">Camera is off</p>
                )}
                {cameraStatus !== 'unsupported' && (
                  <Button
                    size="lg"
                    icon={Camera}
                    onClick={() => {
                      unlockAudio()
                      void startCamera()
                    }}
                  >
                    Start camera
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        <ResultOverlay
          view={view}
          onDismiss={() => setView({ kind: 'ready' })}
          onRetry={retry}
          timeZone={event.timezone}
        />
      </div>

      {/* Camera controls */}
      {running && (
        <div className="grid grid-cols-4 gap-2">
          <Button
            variant="secondary"
            icon={CameraOff}
            onClick={stopCamera}
            className="flex-col gap-1 py-2 text-xs"
          >
            Stop camera
          </Button>
          <Button
            variant="secondary"
            icon={torchOn ? FlashlightOff : Flashlight}
            onClick={() => void toggleTorch()}
            aria-pressed={torchOn}
            disabled={!torchSupported}
            className="flex-col gap-1 py-2 text-xs"
          >
            {torchOn ? 'Torch off' : 'Torch on'}
          </Button>
          <Button
            variant="secondary"
            icon={SwitchCamera}
            onClick={() => void switchCamera()}
            disabled={cameraCount < 2}
            className="flex-col gap-1 py-2 text-xs"
          >
            Switch camera
          </Button>
          <Button
            variant="secondary"
            icon={soundOn ? Volume2 : VolumeX}
            onClick={() => setSoundOn((on) => !on)}
            aria-pressed={soundOn}
            className="flex-col gap-1 py-2 text-xs"
          >
            Sound {soundOn ? 'on' : 'off'}
          </Button>
        </div>
      )}

      {/* Manual entry */}
      <Card className="p-4">
        <form onSubmit={onManualSubmit} className="flex gap-2" aria-label="Manual pass entry">
          <Input
            aria-label="Pass code"
            placeholder="Enter pass code manually"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <Button type="submit" disabled={view.kind === 'checking'}>
            Check
          </Button>
        </form>
        {manualError && <p className="mt-2 text-sm font-medium text-danger-fg">{manualError}</p>}
        <p className="mt-2 text-xs text-fg-subtle">
          The code is printed under the attendee’s QR, e.g. ABCD-EFGH-…
        </p>
      </Card>

      {/* Session history */}
      {history.length > 0 && (
        <Card>
          <h2 className="border-b border-line-soft px-4 py-2.5 text-sm font-semibold text-fg-muted">
            Recent scans on this device
          </h2>
          <ul className="divide-y divide-line-soft">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate font-medium">{h.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className={cx(
                      'rounded-md px-2 py-0.5 text-xs font-bold',
                      h.tone === 'ok' && 'bg-success-muted text-success-fg',
                      h.tone === 'bad' && 'bg-danger-muted text-danger-fg',
                      h.tone === 'warn' && 'bg-warning-muted text-warning-fg',
                    )}
                  >
                    {h.label}
                  </span>
                  <span className="text-xs text-fg-subtle tabular-nums">{h.time}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- result overlay */

function ResultOverlay({
  view,
  onDismiss,
  onRetry,
  timeZone,
}: {
  view: View
  onDismiss: () => void
  onRetry: () => void
  timeZone: string
}) {
  if (view.kind === 'ready') return null

  if (view.kind === 'checking') {
    return (
      <div
        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-scrim px-4 py-5 text-lg font-semibold text-on-inverse"
        role="status"
      >
        <Spinner className="size-6" /> Checking pass…
      </div>
    )
  }

  if (view.kind === 'not_a_pass') {
    return (
      <ResultPanel tone="bad" title="NOT A VALID PASS" onDismiss={onDismiss} testId="scan-result-bad">
        <p className="text-lg">This QR code is not a PassSystem entry pass.</p>
      </ResultPanel>
    )
  }

  const { outcome } = view
  if (outcome.kind === 'error') {
    return (
      <ResultPanel
        tone="warn"
        title="NOT VERIFIED — TRY AGAIN"
        onDismiss={onDismiss}
        testId="scan-result-warn"
      >
        <p className="text-lg">{outcome.message}</p>
        <p className="mt-1 text-base opacity-90">Do not admit until the scan is confirmed.</p>
        <Button
          size="lg"
          className="mt-4 bg-inverse text-on-inverse hover:bg-inverse-raised"
          onClick={(e) => {
            e.stopPropagation()
            onRetry()
          }}
        >
          Retry
        </Button>
      </ResultPanel>
    )
  }

  if (outcome.kind === 'denied') {
    return (
      <ResultPanel tone="bad" title="NOT ALLOWED" onDismiss={onDismiss} testId="scan-result-bad">
        <p className="text-lg">{outcome.message}</p>
      </ResultPanel>
    )
  }

  const r = outcome.response
  const name = r.attendee ? `${r.attendee.first_name} ${r.attendee.last_name}` : null
  const ok = r.result === 'admitted'
  return (
    <ResultPanel
      tone={ok ? 'ok' : 'bad'}
      title={RESULT_TEXT[r.result]}
      onDismiss={onDismiss}
      testId={ok ? 'scan-result-ok' : 'scan-result-bad'}
    >
      {name && (
        <p className="text-3xl leading-tight font-extrabold break-words" data-testid="scan-result-name">
          {name}
        </p>
      )}
      <p className="mt-1 text-lg">{ok ? r.event.name : r.reason}</p>
      {r.checked_in_at && (
        <p className="mt-1 text-lg font-semibold">
          {ok ? 'Checked in at ' : 'First checked in at '}
          {formatTime(r.checked_in_at, timeZone)}
        </p>
      )}
      {ok && r.replayed && (
        <p className="mt-2 text-base font-semibold" data-testid="scan-result-replayed">
          Confirmed on retry: the earlier scan went through.
        </p>
      )}
    </ResultPanel>
  )
}

function ResultPanel({
  tone,
  title,
  children,
  onDismiss,
  testId,
}: {
  tone: 'ok' | 'bad' | 'warn'
  title: string
  children: ReactNode
  onDismiss: () => void
  testId: string
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      onClick={onDismiss}
      className={cx(
        'absolute inset-0 flex cursor-pointer flex-col items-center justify-center p-6 text-center',
        tone === 'ok' && 'bg-success text-on-status',
        tone === 'bad' && 'bg-danger text-on-status',
        tone === 'warn' && 'bg-warning text-fg',
      )}
    >
      <ResultIcon tone={tone} />
      <p className="mt-2 text-2xl font-black tracking-wide">{title}</p>
      <div className="mt-2">{children}</div>
      <p className="mt-5 text-sm opacity-80">Tap to dismiss · keep scanning</p>
    </div>
  )
}

function ResultIcon({ tone }: { tone: 'ok' | 'bad' | 'warn' }) {
  const Icon = tone === 'ok' ? Check : tone === 'bad' ? X : AlertTriangle
  return <Icon className="size-16" strokeWidth={3} aria-hidden="true" />
}
