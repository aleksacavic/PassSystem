import { CalendarPlus, CheckCircle2, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { getPass, type RegistrationResult } from '../../lib/api'
import { ApiError } from '../../lib/errors'
import { buildIcs, downloadIcs } from '../../lib/calendar'
import { dateParts, formatDateTime, formatEventDate } from '../../lib/datetime'
import { errorMessage, useT } from '../../lib/i18n'
import { formatPassToken, normalizePassToken, passUrl } from '../../lib/passToken'
import { renderPassImage, safeFilename, saveImage } from '../../lib/qr'
import { forgetPass, useStoredPasses } from '../../lib/passStorage'
import type { PassView, PublicEvent } from '../../lib/types'
import { CopyButton } from '../../components/CopyButton'
import { GoogleWalletButton } from '../../components/GoogleWalletButton'
import { PublicLayout } from '../../components/PublicLayout'
import { QrImage } from '../../components/QrImage'
import { useQrDataUrl } from '../../components/useQrDataUrl'
import { Alert, Badge, Button, Card, PageSpinner } from '../../components/ui'

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; code: string | null; notFound: boolean }
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
  const { t, locale } = useT()
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
  // Follows the saved-pass store, so it updates if the pass is saved or removed in another tab.
  const stored = useStoredPasses()
  const storedHere = Boolean(token && stored.some((p) => p.token === token))
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
                  code: err?.code ?? null,
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
    document.title = state.kind === 'ready' ? `${t('pass.title')} · ${state.event.name}` : t('pass.title')
  }, [state, t])

  if (state.kind === 'missing') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">{t('pass.missing')}</h1>
          <p className="mt-2 text-fg-muted">{t('pass.missingBody')}</p>
          <Link to="/" className="mt-4 inline-block font-semibold text-brand underline">
            {t('pass.savedOnDevice')}
          </Link>
        </Card>
      </PublicLayout>
    )
  }

  if (state.kind === 'loading') {
    return (
      <PublicLayout>
        <PageSpinner label={t('loading')} />
      </PublicLayout>
    )
  }

  if (state.kind === 'error') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">{state.notFound ? t('pass.notFound') : t('pass.loadError')}</h1>
          <p className="mt-2 text-fg-muted">{errorMessage(t, state.code, 'pass.loadErrorBody')}</p>
          {!state.notFound && (
            <Button className="mt-5" onClick={retry}>
              {t('tryAgain')}
            </Button>
          )}
        </Card>
      </PublicLayout>
    )
  }

  const { pass, event } = state
  const fullName = `${pass.first_name} ${pass.last_name}`
  // An archived event admits no one: its passes are kept but shown as not active.
  const inactive = event.status === 'archived'
  const usable = pass.status === 'registered' && !inactive
  const when = dateParts(event.starts_at, event.timezone, locale)

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
      setSaveError(t('pass.saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function onCalendar() {
    if (!token || !url) return
    // A stable id per pass that does not reveal the pass code.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    const uid = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
    downloadIcs(
      buildIcs({
        uid: `${uid}@passsystem`,
        title: event.name,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        location: event.location,
        description: t('pass.calendarNote', { url }),
        url,
      }),
      `${safeFilename(event.name)}.ics`,
    )
  }

  return (
    <PublicLayout tone="brand">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 text-on-brand-muted">
          {navState.justRegistered ? (
            <p className="flex items-center gap-2 text-[15px] font-bold text-on-brand" role="status">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              {t('pass.registered')}
            </p>
          ) : (
            <span />
          )}
          {storedHere && <span className="text-xs font-semibold">{t('pass.savedHere')}</span>}
        </div>
        {navState.justRegistered && <p className="text-sm text-on-brand-muted">{t('pass.keep')}</p>}

        <section aria-label={t('pass.title')} className="rounded-card bg-surface text-fg shadow-raised">
          <div className="space-y-3 px-5 pt-5 pb-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-extrabold tracking-[0.14em] text-brand uppercase">
                {t('pass.kicker')}
              </span>
              <PassStatus status={pass.status} inactive={inactive} />
            </div>
            <h1 className="text-2xl leading-tight font-extrabold tracking-tight break-words">
              <bdi>{event.name}</bdi>
            </h1>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <dt className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">
                  {t('pass.date')}
                </dt>
                <dd className="text-[15px] font-bold">{when.date}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">
                  {t('pass.doors')}
                </dt>
                <dd className="text-[15px] font-bold">{when.time}</dd>
              </div>
              {event.location && (
                <div className="col-span-2">
                  <dt className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">
                    {t('pass.venue')}
                  </dt>
                  <dd className="text-[15px] font-bold break-words">
                    <bdi>{event.location}</bdi>
                  </dd>
                </div>
              )}
              <div className="col-span-2">
                <dt className="text-[11px] font-bold tracking-wider text-fg-subtle uppercase">
                  {t('pass.guest')}
                </dt>
                <dd className="truncate text-lg font-extrabold" data-testid="pass-name">
                  <bdi>{fullName}</bdi>
                </dd>
              </div>
            </dl>
          </div>

          {/* Perforation: notches in the page colour and a dashed tear line. */}
          <div className="relative flex h-6 items-center" aria-hidden="true">
            <span className="absolute -start-3 size-6 rounded-full bg-primary" />
            <span className="absolute -end-3 size-6 rounded-full bg-primary" />
            <span className="mx-5 flex-1 border-t-2 border-dashed border-line" />
          </div>

          <div className="px-5 pt-3 pb-5 text-center">
            <div className={usable ? '' : 'opacity-30 grayscale'}>
              <QrImage
                dataUrl={qr}
                alt={t('pass.qrAlt', { name: fullName })}
                className="mx-auto max-w-[260px] p-3 ring-1 ring-line-soft"
              />
              {token && (
                <p
                  className="mt-3 font-mono text-[15px] font-semibold tracking-wider text-fg"
                  data-testid="pass-code"
                  dir="ltr"
                >
                  {formatPassToken(token)}
                </p>
              )}
            </div>
            {pass.status === 'registered' && inactive && (
              <p className="mt-3 text-[15px] font-semibold text-warning-fg" data-testid="pass-inactive">
                {t('pass.inactive')}
              </p>
            )}
            {usable && (
              <p className="mt-2 text-sm text-fg-subtle">
                {t('pass.show')} {t('pass.brightness')}
              </p>
            )}
            {pass.status === 'checked_in' && (
              <p className="mt-3 text-[15px] font-semibold text-success-fg">
                {t('pass.used', { when: formatDateTime(pass.checked_in_at, event.timezone, locale) })}
              </p>
            )}
            {pass.status === 'revoked' && (
              <p className="mt-3 text-[15px] font-semibold text-danger-fg">{t('pass.revoked')}</p>
            )}
          </div>
        </section>

        {usable && (
          <div className="no-print grid grid-cols-2 gap-3">
            <Button variant="secondary" size="md" icon={CalendarPlus} onClick={() => void onCalendar()}>
              {t('pass.calendar')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              icon={Download}
              onClick={onSave}
              loading={saving}
              disabled={!qr}
            >
              {t('pass.save')}
            </Button>
          </div>
        )}
        {usable && token && (
          <div className="no-print">
            <GoogleWalletButton token={token} />
          </div>
        )}
        {usable && url && (
          <div className="no-print">
            <CopyButton
              text={url}
              label={t('pass.copy')}
              variant="ghost"
              block
              className="text-on-brand hover:bg-on-brand/10 hover:text-on-brand"
            />
          </div>
        )}
        {saveError && <Alert tone="warn">{saveError}</Alert>}

        <p className="no-print text-center text-sm text-on-brand-muted">{t('pass.private')}</p>
        {storedHere && token && (
          <div className="no-print text-center">
            <button
              type="button"
              className="text-sm font-semibold text-on-brand underline"
              onClick={() => {
                forgetPass(token)
              }}
            >
              {t('pass.forget')}
            </button>
            <p className="mt-1 text-xs text-on-brand-muted">{t('pass.forgetHint')}</p>
          </div>
        )}
      </div>
    </PublicLayout>
  )
}

function PassStatus({ status, inactive }: { status: PassView['status']; inactive: boolean }) {
  const { t } = useT()
  if (status === 'registered' && inactive)
    return (
      <Badge tone="warn" className="text-sm">
        {t('pass.status.inactive')}
      </Badge>
    )
  if (status === 'checked_in')
    return (
      <Badge tone="ok" className="text-sm">
        {t('pass.status.used')}
      </Badge>
    )
  if (status === 'revoked')
    return (
      <Badge tone="bad" className="text-sm">
        {t('pass.status.revoked')}
      </Badge>
    )
  return (
    <Badge tone="accent" className="text-sm">
      {t('pass.status.registered')}
    </Badge>
  )
}
