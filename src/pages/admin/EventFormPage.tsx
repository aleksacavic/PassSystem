import { RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { createEvent, deleteEvent, getDefaultEventTerms, getEvent, updateEvent } from '../../lib/api'
import { emptyForm, fromEvent, validateEventForm, type Errors, type FormState } from '../../lib/eventForm'
import { slugify } from '../../lib/slug'
import type { EventRow, EventStatus } from '../../lib/types'
import { useAuth } from '../../auth/AuthProvider'
import { PageHeader } from '../../components/AdminLayout'
import { Alert, Button, Card, Field, Input, PageSpinner, Select, TextArea } from '../../components/ui'

const zones: string[] = (() => {
  try {
    return (
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ??
      []
    )
  } catch {
    return []
  }
})()

export default function EventFormPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  const [form, setForm] = useState<FormState>(emptyForm)
  const [slugTouched, setSlugTouched] = useState(!isNew)
  const [original, setOriginal] = useState<EventRow | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [defaultTerms, setDefaultTerms] = useState<string | null>(null)

  // Default attendance terms: prefilled for new events, used by "Reset to default".
  useEffect(() => {
    getDefaultEventTerms()
      .then((t) => {
        setDefaultTerms(t)
        if (!id) setForm((f) => (f.termsText ? f : { ...f, termsText: t }))
      })
      .catch(() => undefined)
  }, [id])

  useEffect(() => {
    if (!id) return
    getEvent(id)
      .then((e) => {
        setOriginal(e)
        setForm(fromEvent(e))
      })
      .catch((e: Error) => setSubmitError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value }
      if (key === 'name' && !slugTouched) next.slug = slugify(String(value))
      return next
    })
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    const { errors, input } = validateEventForm(form)
    setErrors(errors)
    if (!input) return
    setSaving(true)
    try {
      const saved = isNew ? await createEvent(input) : await updateEvent(id!, input)
      navigate(`/admin/events/${saved.id}`)
    } catch (err) {
      const msg = (err as Error).message
      if (/already in use/i.test(msg)) setErrors({ slug: 'This link is already used by another event.' })
      else setSubmitError(msg)
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (
      !id ||
      !window.confirm('Delete this event permanently? This is only possible when it has no registrations.')
    )
      return
    try {
      await deleteEvent(id)
      navigate('/admin')
    } catch (err) {
      setSubmitError((err as Error).message)
    }
  }

  if (loading) return <PageSpinner />
  if (isNew && !isAdmin) return <Alert tone="bad">Only administrators can create events.</Alert>

  const slugChanged = original && original.slug !== form.slug && original.status !== 'draft'

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={isNew ? 'Create event' : 'Edit event'}
        back={
          <Link
            to={isNew ? '/admin' : `/admin/events/${id}`}
            className="text-sm font-semibold text-brand hover:underline"
          >
            ← Back
          </Link>
        }
      />
      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <Card className="space-y-4 p-5">
          <Field label="Event name" error={errors.name}>
            {(p) => (
              <Input {...p} maxLength={200} value={form.name} onChange={(e) => set('name', e.target.value)} />
            )}
          </Field>
          <Field
            label="Link name"
            error={errors.slug}
            hint={
              slugChanged
                ? 'Warning: changing this breaks links and QR codes already shared.'
                : `Registration link: /e/${form.slug || '…'}`
            }
          >
            {(p) => (
              <Input
                {...p}
                maxLength={80}
                autoCapitalize="none"
                spellCheck={false}
                value={form.slug}
                onChange={(e) => {
                  setSlugTouched(true)
                  set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                }}
              />
            )}
          </Field>
          <Field label="Description" optional error={errors.description}>
            {(p) => (
              <TextArea
                {...p}
                rows={3}
                maxLength={5000}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            )}
          </Field>
          <Field label="Location" optional error={errors.location}>
            {(p) => (
              <Input
                {...p}
                maxLength={300}
                value={form.location}
                onChange={(e) => set('location', e.target.value)}
              />
            )}
          </Field>
        </Card>

        <Card className="space-y-4 p-5">
          <Field label="Time zone" error={errors.timezone} hint="Times below are entered in this time zone.">
            {(p) => (
              <>
                <Input
                  {...p}
                  list="tz-list"
                  value={form.timezone}
                  onChange={(e) => set('timezone', e.target.value.trim())}
                />
                <datalist id="tz-list">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts" error={errors.startsAt}>
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => set('startsAt', e.target.value)}
                />
              )}
            </Field>
            <Field label="Ends" optional error={errors.endsAt}>
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => set('endsAt', e.target.value)}
                />
              )}
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="text-base font-semibold">Registration</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Opens" optional error={errors.opensAt} hint="Empty: open as soon as published.">
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={form.opensAt}
                  onChange={(e) => set('opensAt', e.target.value)}
                />
              )}
            </Field>
            <Field label="Closes" optional error={errors.closesAt} hint="Empty: closes when the event ends.">
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={form.closesAt}
                  onChange={(e) => set('closesAt', e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field
            label="Maximum attendees"
            optional
            error={errors.maxAttendees}
            hint="Empty for no limit. Revoked passes do not count."
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={1}
                value={form.maxAttendees}
                onChange={(e) => set('maxAttendees', e.target.value)}
              />
            )}
          </Field>
          <Field label="Status" hint="Only published events accept registrations.">
            {(p) => (
              <Select
                {...p}
                value={form.status}
                onChange={(e) => set('status', e.target.value as EventStatus)}
              >
                <option value="draft">Draft — not visible to the public</option>
                <option value="published">Published — registration open</option>
                <option value="closed">Closed — registration closed, scanning allowed</option>
                <option value="archived">Archived — hidden, data kept</option>
              </Select>
            )}
          </Field>
        </Card>

        <Card className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold">Attendance terms</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Attendees must tick “I have read and accept the attendance terms” before they receive their
              pass. The text and time of acceptance are recorded with each registration.
            </p>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              id="terms-required"
              type="checkbox"
              className="mt-0.5 size-5 rounded border-line-strong accent-primary"
              checked={form.termsRequired}
              onChange={(e) => set('termsRequired', e.target.checked)}
            />
            <span className="font-semibold">Require attendees to accept these terms</span>
          </label>
          <Field
            label="Terms text"
            error={errors.termsText}
            hint="Shown on the registration page. Template only: have it reviewed for your event and jurisdiction."
          >
            {(p) => (
              <TextArea
                {...p}
                rows={12}
                maxLength={10000}
                className="font-normal leading-relaxed"
                value={form.termsText}
                onChange={(e) => set('termsText', e.target.value)}
              />
            )}
          </Field>
          {defaultTerms && form.termsText !== defaultTerms && (
            <Button
              variant="secondary"
              size="sm"
              icon={RotateCcw}
              onClick={() => set('termsText', defaultTerms)}
            >
              Reset to default text
            </Button>
          )}
        </Card>

        {submitError && <Alert tone="bad">{submitError}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="submit" size="lg" loading={saving}>
            {isNew ? 'Create event' : 'Save changes'}
          </Button>
          {!isNew && isAdmin && (
            <Button variant="danger-ghost" icon={Trash2} onClick={onDelete}>
              Delete event
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
