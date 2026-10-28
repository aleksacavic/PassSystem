import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { admitPass, getEventSummaries, type AdmitOutcome } from '../../lib/api'
import { formatEventDate, formatTime } from '../../lib/datetime'
import { extractPassToken } from '../../lib/passToken'
import type { EventSummary } from '../../lib/types'
import { ScanGate } from '../../scanner/scanGate'
import { feedback, unlockAudio } from '../../scanner/feedback'
import { useCameraScanner } from '../../scanner/useCameraScanner'
import { useWakeLock } from '../../scanner/useWakeLock'
import { Alert, Button, ButtonLink, Card, Input, PageSpinner, Spinner, cx } from '../../components/ui'
import { EventStatusBadge } from '../../components/StatusBadge'

export default function ScanPage() {
  const { eventId } = useParams()
  return eventId ? <Scanner eventId={eventId} /> : <EventPicker />
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
      <p className="mb-5 text-ink-600">Select the event you are admitting people to.</p>
      {error && <Alert tone="bad">{error}</Alert>}
      {!events && !error && <PageSpinner />}
      {events?.length === 0 && (
        <Card className="p-6 text-center text-ink-600">You are not assigned to any active events.</Card>
      )}
      <div className="space-y-3">
        {events?.map((e) => (
          <Link
            key={e.id}
            to={`/scan/${e.id}`}
            className="block rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink-200/70 hover:ring-ink-400"
            data-testid="scan-event-option"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-lg font-semibold">{e.name}</p>
              <EventStatusBadge status={e.status} />
            </div>
            <p className="text-sm text-ink-600">{formatEventDate(e.starts_at, e.ends_at, e.timezone)}</p>
            <p className="mt-1 text-sm text-ink-500">
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
  | { kind: 'outcome'; outcome: AdmitOutcome; token: string; at: number }
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

  const submit = useCallback(
    async (token: string) => {
      const now = Date.now()
      gate.current.begin(token, now)
      setView({ kind: 'checking' })
      const outcome = await admitPass(eventId, token)
      gate.current.end(token, Date.now())
      const tone = toneOf(outcome)
      feedback(tone, soundRef.current)
      setView({ kind: 'outcome', outcome, token, at: Date.now() })
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
      void submit(token)
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
    void submit(token)
  }

  function retry() {
    if (view.kind !== 'outcome' || gate.current.inFlight) return
    gate.current.reset()
    void submit(view.token)
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

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {/* Persistent event context */}
      <div
        className="flex items-center justify-between gap-3 rounded-2xl bg-ink-900 px-4 py-3 text-white"
        data-testid="scan-event"
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-ink-300 uppercase">Scanning for</p>
          <p className="truncate text-lg font-bold">{event.name}</p>
          <p className="text-xs text-ink-300">
            {event.checked_in_count} admitted · {remaining} to go
          </p>
        </div>
        <Link
          to="/scan"
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-ink-200 ring-1 ring-ink-600 hover:bg-ink-800"
        >
          Change
        </Link>
      </div>

      {event.status === 'archived' && (
        <Alert tone="warn">This event is archived. Scanning is disabled.</Alert>
      )}

      {/* Camera */}
      <div className="relative overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: '1 / 1' }}>
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
            <div className="size-[68%] rounded-3xl border-4 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}
        {!running && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
            {starting ? (
              <>
                <Spinner className="size-8" />
                <p>Starting camera…</p>
              </>
            ) : (
              <>
                {cameraError ? (
                  <p className="max-w-xs text-sm text-ink-200">{cameraError}</p>
                ) : (
                  <p className="text-ink-200">Camera is off</p>
                )}
                {cameraStatus !== 'unsupported' && (
                  <Button
                    size="lg"
                    variant="secondary"
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
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={stopCamera}>
            Stop camera
          </Button>
          {torchSupported && (
            <Button variant="secondary" onClick={() => void toggleTorch()} aria-pressed={torchOn}>
              {torchOn ? 'Torch off' : 'Torch on'}
            </Button>
          )}
          {cameraCount > 1 && (
            <Button variant="secondary" onClick={() => void switchCamera()}>
              Switch camera
            </Button>
          )}
          <Button variant="ghost" onClick={() => setSoundOn((s) => !s)} aria-pressed={soundOn}>
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
        {manualError && <p className="mt-2 text-sm font-medium text-bad-700">{manualError}</p>}
        <p className="mt-2 text-xs text-ink-500">
          The code is printed under the attendee’s QR, e.g. ABCD-EFGH-…
        </p>
      </Card>

      {/* Session history */}
      {history.length > 0 && (
        <Card>
          <h2 className="border-b border-ink-100 px-4 py-2.5 text-sm font-semibold text-ink-600">
            Recent scans on this device
          </h2>
          <ul className="divide-y divide-ink-100">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate font-medium">{h.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className={cx(
                      'rounded-md px-2 py-0.5 text-xs font-bold',
                      h.tone === 'ok' && 'bg-ok-100 text-ok-700',
                      h.tone === 'bad' && 'bg-bad-100 text-bad-700',
                      h.tone === 'warn' && 'bg-warn-100 text-warn-800',
                    )}
                  >
                    {h.label}
                  </span>
                  <span className="text-xs text-ink-500 tabular-nums">{h.time}</span>
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
        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-ink-900/85 px-4 py-5 text-lg font-semibold text-white"
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
          className="mt-4 bg-ink-900 text-white hover:bg-ink-800"
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
        tone === 'ok' && 'bg-ok-600 text-white',
        tone === 'bad' && 'bg-bad-600 text-white',
        tone === 'warn' && 'bg-warn-500 text-ink-900',
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
  return (
    <svg
      viewBox="0 0 48 48"
      className="size-16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {tone === 'ok' && <path d="M10 25l9 9 19-20" />}
      {tone === 'bad' && <path d="M13 13l22 22M35 13L13 35" />}
      {tone === 'warn' && (
        <>
          <path d="M24 12v15" />
          <path d="M24 36h.01" />
        </>
      )}
    </svg>
  )
}
