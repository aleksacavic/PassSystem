import { browserTimeZone, isoToZonedInput, isValidTimeZone, zonedInputToIso } from './datetime'
import { isValidSlug } from './slug'
import type { EventInput, EventRow, EventStatus } from './types'

export interface FormState {
  name: string
  slug: string
  description: string
  location: string
  timezone: string
  startsAt: string
  endsAt: string
  opensAt: string
  closesAt: string
  maxAttendees: string
  status: EventStatus
}

export type Errors = Partial<Record<keyof FormState, string>>

export function emptyForm(): FormState {
  return {
    name: '',
    slug: '',
    description: '',
    location: '',
    timezone: browserTimeZone(),
    startsAt: '',
    endsAt: '',
    opensAt: '',
    closesAt: '',
    maxAttendees: '',
    status: 'draft',
  }
}

export function fromEvent(e: EventRow): FormState {
  return {
    name: e.name,
    slug: e.slug,
    description: e.description ?? '',
    location: e.location ?? '',
    timezone: e.timezone,
    startsAt: isoToZonedInput(e.starts_at, e.timezone),
    endsAt: isoToZonedInput(e.ends_at, e.timezone),
    opensAt: isoToZonedInput(e.registration_opens_at, e.timezone),
    closesAt: isoToZonedInput(e.registration_closes_at, e.timezone),
    maxAttendees: e.max_attendees ? String(e.max_attendees) : '',
    status: e.status,
  }
}

export function validateEventForm(f: FormState): { errors: Errors; input?: EventInput } {
  const errors: Errors = {}
  const name = f.name.trim()
  if (!name) errors.name = 'Name is required.'
  else if (name.length > 200) errors.name = 'At most 200 characters.'
  if (!isValidSlug(f.slug)) errors.slug = 'Use lowercase letters, digits and dashes (max 80).'
  if (f.location.length > 300) errors.location = 'At most 300 characters.'
  if (f.description.length > 5000) errors.description = 'At most 5000 characters.'
  if (!isValidTimeZone(f.timezone)) errors.timezone = 'Unknown time zone (e.g. Europe/Belgrade).'
  const tz = errors.timezone ? 'UTC' : f.timezone
  const startsAt = zonedInputToIso(f.startsAt, tz)
  if (!startsAt) errors.startsAt = 'Start date and time are required.'
  const endsAt = f.endsAt ? zonedInputToIso(f.endsAt, tz) : null
  if (f.endsAt && !endsAt) errors.endsAt = 'Invalid date.'
  if (startsAt && endsAt && endsAt < startsAt) errors.endsAt = 'End must be after the start.'
  const opensAt = f.opensAt ? zonedInputToIso(f.opensAt, tz) : null
  const closesAt = f.closesAt ? zonedInputToIso(f.closesAt, tz) : null
  if (opensAt && closesAt && closesAt <= opensAt) errors.closesAt = 'Registration must close after it opens.'
  let max: number | null = null
  if (f.maxAttendees.trim()) {
    max = Number(f.maxAttendees)
    if (!Number.isInteger(max) || max < 1 || max > 1_000_000)
      errors.maxAttendees = 'Enter a whole number from 1.'
  }
  if (Object.keys(errors).length) return { errors }
  return {
    errors,
    input: {
      name,
      slug: f.slug,
      description: f.description.trim() || null,
      location: f.location.trim() || null,
      timezone: f.timezone,
      starts_at: startsAt!,
      ends_at: endsAt,
      registration_opens_at: opensAt,
      registration_closes_at: closesAt,
      max_attendees: max,
      status: f.status,
    },
  }
}
