import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { getPass, type RegistrationResult } from '../../lib/api'
import { ApiError } from '../../lib/errors'
import { formatDateTime, formatEventDate } from '../../lib/datetime'
import { formatPassToken, normalizePassToken, passUrl } from '../../lib/passToken'
import { renderPassImage, safeFilename, saveImage } from '../../lib/qr'
import { forgetPass } from '../../lib/passStorage'
import type { PassView, PublicEvent } from '../../lib/types'
import { CopyButton } from '../../components/CopyButton'
import { EventInfo } from '../../components/EventInfo'
import { PublicLayout } from '../../components/PublicLayout'
import { QrImage } from '../../components/QrImage'
import { useQrDataUrl } from '../../components/useQrDataUrl'
import { Alert, Badge, Button, Card, PageSpinner } from '../../components/ui'

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string; notFound: boolean }
  | { kind: 'ready'; pass: PassView; event: PublicEvent }

interface LocationState {
  justRegistered?: boolean
  result?: RegistrationResult
}

/** Remount per token so state never leaks between passes. */
export default function PassPageRoute() {
  const location = useLocation()
  return <PassPage key={location.hash} />
}

function PassPage() {
  const location = useLocation()
  const token = normalizePassToken(decodeURIComponent(location.hash.replace(/^#/, '')))
  const navState = (location.state ?? {}) as LocationState
  const initial: State =
    navState.result && navState.result.token === token
      ? {
          kind: 'ready',
          pass: { ...navState.result.registration, checked_in_at: null },
          event: navState.result.event,
        }
      : token
        ? { kind: 'loading' }
        : { kind: 'missing' }
  const [state, setState] = useState<State>(initial)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const url = token ? passUrl(token) : null
  const qr = useQrDataUrl(url)

  const [reloadKey, setReloadKey] = useState(0)
  const retry = () => setReloadKey((k) => k + 1)

  // Load the authoritative pass status, and re-check whenever the page becomes
  // visible again (e.g. the attendee reopens the tab after entry).
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const refresh = () =>
      getPass(token)
        .then(({ pass, event }) => !cancelled && setState({ kind: 'ready', pass, event }))
        .catch((e: unknown) => {
          if (cancelled) return
          const err = e instanceof ApiError ? e : null
          if (err?.code === 'pass_not_found') forgetPass(token)
          setState((prev) =>
            prev.kind === 'ready' && err?.code !== 'pass_not_found'
              ? prev // keep showing the pass if only a refresh failed
              : {
                  kind: 'error',
                  message: err?.message ?? 'Could not load the pass.',
                  notFound: err?.code === 'pass_not_found',
                },
          )
        })
    void refresh()
    const onVisible = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [token, reloadKey])

  useEffect(() => {
    document.title = state.kind === 'ready' ? `Pass · ${state.event.name}` : 'Your pass'
  }, [state])

  if (state.kind === 'missing') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">No pass in this link</h1>
          <p className="mt-2 text-ink-600">Open the full pass link you received after registering.</p>
          <Link to="/" className="mt-4 inline-block font-semibold text-accent-600 underline">
            Passes saved on this device
          </Link>
        </Card>
      </PublicLayout>
    )
  }

  if (state.kind === 'loading') {
    return (
      <PublicLayout>
        <PageSpinner label="Loading pass" />
      </PublicLayout>
    )
  }

  if (state.kind === 'error') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">{state.notFound ? 'Pass not found' : 'Could not load pass'}</h1>
          <p className="mt-2 text-ink-600">{state.message}</p>
          {!state.notFound && (
            <Button className="mt-5" onClick={retry}>
              Try again
            </Button>
          )}
        </Card>
      </PublicLayout>
    )
  }

  const { pass, event } = state
  const fullName = `${pass.first_name} ${pass.last_name}`
  const usable = pass.status === 'registered'

  async function onSave() {
    if (!qr || !token) return
    setSaving(true)
    setSaveError(null)
    try {
      const blob = await renderPassImage({
        qr,
        title: event.name,
        subtitle: fullName,
        lines: [
          formatEventDate(event.starts_at, event.ends_at, event.timezone),
          ...(event.location ? [event.location] : []),
        ],
        footer: formatPassToken(token),
      })
      await saveImage(blob, `pass-${safeFilename(event.name)}-${safeFilename(fullName)}.png`)
    } catch {
      setSaveError('Could not save the image. Take a screenshot instead.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PublicLayout>
      <div className="space-y-5">
        {navState.justRegistered && (
          <Alert tone="ok" title="You are registered!">
            Keep this pass: save the QR image or bookmark this page.
          </Alert>
        )}

        <Card className="overflow-hidden">
          <div className="space-y-4 p-5">
            <EventInfo event={event} compact />
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide text-ink-500 uppercase">Attendee</p>
                <p className="truncate text-xl font-bold" data-testid="pass-name">
                  {fullName}
                </p>
              </div>
              <PassStatus status={pass.status} />
            </div>
          </div>

          <div className={usable ? 'bg-white px-5 pb-5' : 'bg-white px-5 pb-5 opacity-30 grayscale'}>
            <QrImage
              dataUrl={qr}
              alt={`Entry QR code for ${fullName}`}
              className="mx-auto max-w-[340px] ring-1 ring-ink-100"
            />
            {token && (
              <p
                className="mt-3 text-center font-mono text-sm tracking-wider text-ink-600"
                data-testid="pass-code"
              >
                {formatPassToken(token)}
              </p>
            )}
          </div>

          <div className="border-t border-ink-100 bg-ink-50 px-5 py-4 text-center">
            {pass.status === 'registered' && (
              <p className="text-base font-semibold">Show this QR code at the entrance.</p>
            )}
            {pass.status === 'checked_in' && (
              <p className="text-base font-semibold text-ok-700">
                This pass was used for entry on {formatDateTime(pass.checked_in_at, event.timezone)}.
              </p>
            )}
            {pass.status === 'revoked' && (
              <p className="text-base font-semibold text-bad-700">
                This pass has been revoked and is not valid for entry. Contact the organizer.
              </p>
            )}
            {usable && (
              <p className="mt-1 text-sm text-ink-500">Tip: turn up your screen brightness at the door.</p>
            )}
          </div>
        </Card>

        {usable && (
          <div className="no-print grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button size="lg" onClick={onSave} loading={saving} disabled={!qr}>
              Save QR
            </Button>
            {url && <CopyButton text={url} label="Copy pass link" size="lg" />}
          </div>
        )}
        {saveError && <Alert tone="warn">{saveError}</Alert>}

        <p className="no-print text-center text-sm text-ink-500">
          This link is your personal pass. Do not share it with others.
        </p>
      </div>
    </PublicLayout>
  )
}

function PassStatus({ status }: { status: PassView['status'] }) {
  if (status === 'checked_in')
    return (
      <Badge tone="ok" className="text-sm">
        Used
      </Badge>
    )
  if (status === 'revoked')
    return (
      <Badge tone="bad" className="text-sm">
        Revoked
      </Badge>
    )
  return (
    <Badge tone="accent" className="text-sm">
      Registered
    </Badge>
  )
}
