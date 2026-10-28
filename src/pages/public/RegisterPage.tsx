import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { getPublicEvent, registerForEvent } from '../../lib/api'
import { ApiError } from '../../lib/errors'
import { formatDateTime } from '../../lib/datetime'
import { passesForEvent, savePass, type StoredPass } from '../../lib/passStorage'
import { randomUuid } from '../../lib/random'
import type { PublicEvent, RegistrationState } from '../../lib/types'
import {
  cleanName,
  cleanPhone,
  normalizeEmail,
  validateRegistration,
  type RegistrationErrors,
} from '../../lib/validation'
import { EventInfo } from '../../components/EventInfo'
import { PublicLayout } from '../../components/PublicLayout'
import { Alert, Button, Card, Field, Input, PageSpinner } from '../../components/ui'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; notFound: boolean }
  | { kind: 'ready'; event: PublicEvent; state: RegistrationState }

export default function RegisterPage() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
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
          message: err?.message ?? 'Could not load this event.',
          notFound: err?.code === 'event_not_found',
        })
      })
    return () => {
      cancelled = true
    }
  }, [slug, reloadKey])

  useEffect(() => {
    if (load.kind === 'ready') document.title = `${load.event.name} · Register`
  }, [load])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (inFlight.current || load.kind !== 'ready') return
    const v: RegistrationErrors & { terms?: string } = validateRegistration(form)
    if (load.event.terms_required && !acceptTerms) v.terms = 'Please read and accept the attendance terms.'
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
        setErrors({ terms: apiErr.message })
        setReloadKey((k) => k + 1)
      } else if (apiErr?.code === 'invalid_input' && apiErr.field && apiErr.field !== 'form') {
        const fields: Record<string, keyof RegistrationErrors> = {
          first_name: 'firstName',
          last_name: 'lastName',
          email: 'email',
          phone: 'phone',
        }
        setErrors({ [fields[apiErr.field] ?? 'firstName']: 'Please check this field.' })
      } else {
        setSubmitError(apiErr?.message ?? 'Network error. Check your connection and try again.')
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
        <PageSpinner label="Loading event" />
      </PublicLayout>
    )
  }

  if (load.kind === 'error') {
    return (
      <PublicLayout>
        <Card className="p-6 text-center">
          <h1 className="text-xl font-bold">{load.notFound ? 'Event not found' : 'Something went wrong'}</h1>
          <p className="mt-2 text-ink-600">
            {load.notFound
              ? 'Check that the link is correct. The event may not be published yet.'
              : load.message}
          </p>
          {!load.notFound && (
            <Button className="mt-5" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
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
        <EventInfo event={event} />
        {event.description && (
          <p className="text-[15px] leading-relaxed whitespace-pre-line text-ink-700">{event.description}</p>
        )}

        {existing.length > 0 && (
          <Alert tone="info" title="You already have a pass on this device">
            <ul className="mt-1 space-y-1">
              {existing.map((p) => (
                <li key={p.token}>
                  <Link className="font-semibold underline" to={`/pass#${p.token}`}>
                    View pass for {p.attendeeName}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-1">You can still register another person below.</p>
          </Alert>
        )}

        {state === 'draft' && (
          <Alert tone="warn" title="Preview">
            This event is a draft and is only visible to staff. Publish it to open registration.
          </Alert>
        )}

        {!open && state !== 'draft' && <RegistrationUnavailable state={state} event={event} />}

        {open && (
          <Card className="p-5">
            <h2 className="text-lg font-semibold">Register</h2>
            <p className="mt-1 text-sm text-ink-600">
              Enter your name to receive your personal entry pass. No account needed.
            </p>
            <form className="mt-5 space-y-4" onSubmit={onSubmit} noValidate>
              <Field label="First name" error={errors.firstName}>
                {(p) => (
                  <Input
                    {...p}
                    name="given-name"
                    autoComplete="given-name"
                    autoCapitalize="words"
                    maxLength={100}
                    required
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Last name" error={errors.lastName}>
                {(p) => (
                  <Input
                    {...p}
                    name="family-name"
                    autoComplete="family-name"
                    autoCapitalize="words"
                    maxLength={100}
                    required
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Email"
                optional
                error={errors.email}
                hint="Only used by the organizer to contact you."
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
                    maxLength={254}
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="Phone"
                optional
                error={errors.phone}
                hint="With country code, e.g. +971 50 123 4567."
              >
                {(p) => (
                  <Input
                    {...p}
                    type="tel"
                    name="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+971 50 123 4567"
                    maxLength={40}
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                )}
              </Field>
              {event.terms_required && event.terms_text && (
                <div className="space-y-2">
                  <details
                    className="rounded-xl bg-ink-50 ring-1 ring-ink-200 ring-inset"
                    data-testid="terms"
                  >
                    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
                      Read the attendance terms
                    </summary>
                    <div className="max-h-72 overflow-y-auto border-t border-ink-200 px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-ink-700">
                      {event.terms_text}
                    </div>
                  </details>
                  <label className="flex items-start gap-3 text-[15px]">
                    <input
                      id="accept-terms"
                      type="checkbox"
                      className="mt-0.5 size-5 shrink-0 rounded border-ink-300 accent-ink-900"
                      checked={acceptTerms}
                      aria-invalid={errors.terms ? true : undefined}
                      aria-describedby={errors.terms ? 'accept-terms-error' : undefined}
                      onChange={(e) => {
                        setAcceptTerms(e.target.checked)
                        if (e.target.checked) setErrors((er) => ({ ...er, terms: undefined }))
                      }}
                    />
                    <span>I have read and accept the attendance terms.</span>
                  </label>
                  {errors.terms && (
                    <p id="accept-terms-error" className="text-sm font-medium text-bad-700" role="alert">
                      {errors.terms}
                    </p>
                  )}
                </div>
              )}
              {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
              <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
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
              <Button type="submit" size="lg" block loading={submitting}>
                {submitting ? 'Registering…' : 'Register'}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </PublicLayout>
  )
}

function RegistrationUnavailable({ state, event }: { state: RegistrationState; event: PublicEvent }) {
  if (state === 'not_open') {
    return (
      <Alert tone="warn" title="Registration has not opened yet">
        {event.registration_opens_at
          ? `Registration opens ${formatDateTime(event.registration_opens_at, event.timezone)}.`
          : 'Please check back later.'}
      </Alert>
    )
  }
  if (state === 'full') {
    return (
      <Alert tone="warn" title="This event is full">
        The maximum number of registrations has been reached.
      </Alert>
    )
  }
  return (
    <Alert tone="warn" title="Registration is closed">
      This event is no longer accepting registrations.
    </Alert>
  )
}
