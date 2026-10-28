import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Clock, MapPin, Ticket } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { getPublicEvent, registerForEvent } from '../../lib/api'
import { ApiError } from '../../lib/errors'
import { formatDateTime, formatEventDate, zoneLabel } from '../../lib/datetime'
import { errorMessage, useT, type MessageKey } from '../../lib/i18n'
import { passesForEvent, savePass, type StoredPass } from '../../lib/passStorage'
import { randomUuid } from '../../lib/random'
import type { PublicEvent, RegistrationState } from '../../lib/types'
import {
  NAME_MAX,
  cleanName,
  cleanPhone,
  emailInvalid,
  nameProblem,
  normalizeEmail,
  phoneInvalid,
  type NameProblem,
  type RegistrationErrors,
} from '../../lib/validation'
import { DateTile } from '../../components/DateTile'
import { PublicLayout } from '../../components/PublicLayout'
import { Alert, Button, Card, Field, Input, PageSpinner } from '../../components/ui'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; code: string | null; notFound: boolean }
  | { kind: 'ready'; event: PublicEvent; state: RegistrationState }

const NAME_MESSAGES: Record<NameProblem, MessageKey> = {
  required: 'error.nameRequired',
  too_long: 'error.nameTooLong',
  invalid_chars: 'error.nameChars',
  no_letter: 'error.nameLetter',
}

export default function RegisterPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const { t, locale } = useT()
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', website: '' })
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [errors, setErrors] = useState<RegistrationErrors & { terms?: string }>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [existing] = useState<StoredPass[]>(() => passesForEvent(slug))
  // One idempotency key per registration attempt; reused if the user retries
  // after a network failure so the server never creates a duplicate.
  const requestId = useRef<string>(randomUuid())
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    getPublicEvent(slug)
      .then(({ event, registrationState }) => {
        if (!cancelled) setLoad({ kind: 'ready', event, state: registrationState })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const err = e instanceof ApiError ? e : null
        setLoad({
          kind: 'error',
          message: err?.message ?? t('error.network'),
          code: err?.code ?? null,
          notFound: err?.code === 'event_not_found',
        })
      })
    return () => {
      cancelled = true
    }
    // t only changes with the language; the effect must not refetch for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, reloadKey])

  useEffect(() => {
    if (load.kind === 'ready') document.title = `${load.event.name} · Register`
  }, [load])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (inFlight.current || load.kind !== 'ready') return
    const v: RegistrationErrors & { terms?: string } = {}
    const first = nameProblem(form.firstName)
    const last = nameProblem(form.lastName)
    if (first) v.firstName = t(NAME_MESSAGES[first], { label: t('form.firstName'), max: NAME_MAX })
    if (last) v.lastName = t(NAME_MESSAGES[last], { label: t('form.lastName'), max: NAME_MAX })
    if (emailInvalid(form.email)) v.email = t('error.email')
    if (phoneInvalid(form.phone)) v.phone = t('error.phone')
    if (load.event.terms_required && !acceptTerms) v.terms = t('error.terms_not_accepted')
    setErrors(v)
    setSubmitError(null)
    if (Object.keys(v).length > 0) return

    inFlight.current = true
    setSubmitting(true)
    try {
      const result = await registerForEvent({
        slug,
        firstName: cleanName(form.firstName),
        lastName: cleanName(form.lastName),
        email: normalizeEmail(form.email),
        phone: cleanPhone(form.phone),
        acceptTerms: Boolean(load.event.terms_required) && acceptTerms,
        termsVersion: load.event.terms_required ? (load.event.terms_version ?? null) : null,
        requestId: requestId.current,
        website: form.website,
      })
      savePass({
        token: result.token,
        slug,
        eventName: result.event.name,
        attendeeName: `${result.registration.first_name} ${result.registration.last_name}`,
        startsAt: result.event.starts_at,
        savedAt: new Date().toISOString(),
      })
      requestId.current = randomUuid()
      navigate(`/pass#${result.token}`, { state: { justRegistered: true, result } })
    } catch (err) {
      const apiErr = err instanceof ApiError ? (err as ApiError & { field?: string }) : null
      if (apiErr?.code === 'terms_not_accepted' || apiErr?.code === 'terms_changed') {
        // The organizer may have just switched terms on or edited them: show the
        // current text and ask for a fresh acceptance.
        setAcceptTerms(false)
        setErrors({ terms: errorMessage(t, apiErr.code, apiErr.message) })
        setReloadKey((k) => k + 1)
      } else if (apiErr?.code === 'invalid_input' && apiErr.field && apiErr.field !== 'form') {
        const fields: Record<string, keyof RegistrationErrors> = {
          first_name: 'firstName',
          last_name: 'lastName',
          email: 'email',
          phone: 'phone',
        }
        setErrors({ [fields[apiErr.field] ?? 'firstName']: t('error.field') })
      } else {
        setSubmitError(apiErr ? errorMessage(t, apiErr.code, apiErr.message) : t('error.network'))
      }
      if (apiErr?.code === 'duplicate_request') requestId.current = randomUuid()
      if (
        apiErr &&
        ['registration_closed', 'event_full', 'registration_not_open'].includes(apiErr.code ?? '')
      ) {
        setReloadKey((k) => k + 1)
      }
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  if (load.kind === 'loading') {
    return (
      <PublicLayout>
        <PageSpinner label={t('loading')} />
      </PublicLayout>
    )
  }

  if (load.kind === 'error') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">{load.notFound ? t('event.notFound') : t('event.error')}</h1>
          <p className="mt-2 text-fg-muted">
            {load.notFound ? t('event.notFoundBody') : errorMessage(t, load.code, load.message)}
          </p>
          {!load.notFound && (
            <Button className="mt-5" onClick={() => setReloadKey((k) => k + 1)}>
              {t('tryAgain')}
            </Button>
          )}
        </Card>
      </PublicLayout>
    )
  }

  const { event, state } = load
  const open = state === 'open'

  return (
    <PublicLayout>
      <div className="space-y-5">
        <article className="overflow-hidden rounded-card bg-surface shadow-raised">
          <div className="band-pattern h-24 bg-primary" aria-hidden="true" />
          <div className="space-y-3 px-5 pb-5">
            <div className="-mt-8 flex items-end gap-3">
              <DateTile iso={event.starts_at} timeZone={event.timezone} locale={locale} />
              {open && (
                <span className="mb-1 rounded-pill bg-brand-soft px-2.5 py-1 text-xs font-bold text-primary">
                  {t('event.open')}
                </span>
              )}
            </div>
            <h1 className="text-[1.65rem] leading-tight font-extrabold tracking-tight break-words">
              <bdi>{event.name}</bdi>
            </h1>
            <div className="space-y-1.5 text-[15px] text-fg-muted">
              <p className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                <span>
                  {formatEventDate(event.starts_at, event.ends_at, event.timezone, locale)}{' '}
                  <span className="text-fg-subtle" dir="ltr">
                    ({zoneLabel(event.starts_at, event.timezone)})
                  </span>
                </span>
              </p>
              {event.location && (
                <p className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                  <bdi className="break-words">{event.location}</bdi>
                </p>
              )}
            </div>
            {event.description && (
              <p className="text-[15px] leading-relaxed whitespace-pre-line text-fg-muted" dir="auto">
                {event.description}
              </p>
            )}
          </div>
        </article>

        {existing.length > 0 && (
          <Alert tone="info" title={t('event.existing')}>
            <ul className="mt-1 space-y-1">
              {existing.map((p) => (
                <li key={p.token}>
                  <Link className="font-semibold underline" to={`/pass#${p.token}`}>
                    {t('event.viewPass', { name: p.attendeeName })}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-1">{t('event.registerAnother')}</p>
          </Alert>
        )}

        {state === 'draft' && <Alert tone="warn">{t('event.draft')}</Alert>}

        {!open && state !== 'draft' && <RegistrationUnavailable state={state} event={event} />}

        {open && (
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('form.firstName')} error={errors.firstName}>
                {(p) => (
                  <Input
                    {...p}
                    name="given-name"
                    autoComplete="given-name"
                    autoCapitalize="words"
                    dir="auto"
                    maxLength={100}
                    required
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('form.lastName')} error={errors.lastName}>
                {(p) => (
                  <Input
                    {...p}
                    name="family-name"
                    autoComplete="family-name"
                    autoCapitalize="words"
                    dir="auto"
                    maxLength={100}
                    required
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field
              label={t('form.email')}
              optional={t('optional')}
              error={errors.email}
              hint={t('form.emailHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  dir="ltr"
                  maxLength={254}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              )}
            </Field>
            <Field
              label={t('form.phone')}
              optional={t('optional')}
              error={errors.phone}
              hint={t('form.phoneHint')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="tel"
                  name="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  dir="ltr"
                  placeholder="+971 50 123 4567"
                  maxLength={40}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              )}
            </Field>
            {event.terms_required && event.terms_text && (
              <div className="space-y-2">
                <div
                  className={
                    errors.terms
                      ? 'rounded-control bg-surface ring-2 ring-danger ring-inset'
                      : 'rounded-control bg-surface ring-1 ring-line ring-inset'
                  }
                >
                  <label className="flex items-start gap-3 px-4 py-3.5 text-[15px]">
                    <input
                      id="accept-terms"
                      type="checkbox"
                      className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-primary"
                      checked={acceptTerms}
                      aria-invalid={errors.terms ? true : undefined}
                      aria-describedby={errors.terms ? 'accept-terms-error' : undefined}
                      onChange={(e) => {
                        setAcceptTerms(e.target.checked)
                        if (e.target.checked) setErrors((er) => ({ ...er, terms: undefined }))
                      }}
                    />
                    <span>{t('form.acceptTerms')}</span>
                  </label>
                  <details className="border-t border-line-soft" data-testid="terms">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-brand">
                      {t('form.readTerms')}
                    </summary>
                    <div
                      className="max-h-72 overflow-y-auto px-4 pb-4 text-sm leading-relaxed whitespace-pre-line text-fg"
                      dir="auto"
                    >
                      {event.terms_text}
                    </div>
                  </details>
                </div>
                {errors.terms && (
                  <p id="accept-terms-error" className="text-sm font-medium text-danger-fg" role="alert">
                    {errors.terms}
                  </p>
                )}
              </div>
            )}
            {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
            <div aria-hidden="true" className="pointer-events-none fixed top-0 left-0 size-px overflow-hidden opacity-0">
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  name="website"
                  value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                />
              </label>
            </div>
            {submitError && <Alert tone="bad">{submitError}</Alert>}
            <div className="sticky bottom-0 -mx-4 bg-linear-to-t from-canvas from-70% to-transparent px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Button type="submit" size="lg" block icon={Ticket} loading={submitting}>
                {submitting ? t('form.submitting') : t('form.submit')}
              </Button>
              <p className="mt-2 text-center text-xs text-fg-subtle">{t('form.noAccount')}</p>
            </div>
          </form>
        )}
      </div>
    </PublicLayout>
  )
}

function RegistrationUnavailable({ state, event }: { state: RegistrationState; event: PublicEvent }) {
  const { t, locale } = useT()
  if (state === 'not_open') {
    return (
      <Alert tone="warn" title={t('event.notOpen')}>
        {event.registration_opens_at
          ? t('event.opensAt', { when: formatDateTime(event.registration_opens_at, event.timezone, locale) })
          : t('event.checkBack')}
      </Alert>
    )
  }
  if (state === 'full') {
    return (
      <Alert tone="warn" title={t('event.full')}>
        {t('event.fullBody')}
      </Alert>
    )
  }
  return (
    <Alert tone="warn" title={t('event.closed')}>
      {t('event.closedBody')}
    </Alert>
  )
}
