import { describe, expect, it } from 'vitest'
import { emptyForm, validateEventForm } from './eventForm'

const base = {
  ...emptyForm(),
  name: 'Gala',
  slug: 'gala',
  timezone: 'Europe/Belgrade',
  startsAt: '2026-11-20T18:00',
}

describe('validateEventForm', () => {
  it('builds an API payload in UTC', () => {
    const { errors, input } = validateEventForm({ ...base, endsAt: '2026-11-20T23:00', maxAttendees: '150' })
    expect(errors).toEqual({})
    expect(input?.starts_at).toBe('2026-11-20T17:00:00.000Z')
    expect(input?.ends_at).toBe('2026-11-20T22:00:00.000Z')
    expect(input?.max_attendees).toBe(150)
    expect(input?.description).toBeNull()
  })
  it('rejects end before start, bad windows, capacity and zone', () => {
    expect(validateEventForm({ ...base, endsAt: '2026-11-20T10:00' }).errors.endsAt).toBeTruthy()
    expect(
      validateEventForm({ ...base, opensAt: '2026-11-10T10:00', closesAt: '2026-11-09T10:00' }).errors
        .closesAt,
    ).toBeTruthy()
    expect(validateEventForm({ ...base, maxAttendees: '0' }).errors.maxAttendees).toBeTruthy()
    expect(validateEventForm({ ...base, maxAttendees: '2.5' }).errors.maxAttendees).toBeTruthy()
    expect(validateEventForm({ ...base, timezone: 'Nowhere/City' }).errors.timezone).toBeTruthy()
    expect(validateEventForm({ ...base, startsAt: '' }).errors.startsAt).toBeTruthy()
    expect(validateEventForm({ ...base, slug: 'Bad Slug' }).errors.slug).toBeTruthy()
  })
})

describe('daylight-saving gaps', () => {
  it('rejects wall-clock times that do not exist', () => {
    expect(validateEventForm({ ...base, startsAt: '2026-03-29T02:30' }).errors.startsAt).toMatch(
      /does not exist/,
    )
    expect(
      validateEventForm({ ...base, timezone: 'America/New_York', startsAt: '2026-03-08T02:30' }).errors
        .startsAt,
    ).toMatch(/does not exist/)
    expect(validateEventForm({ ...base, startsAt: '2026-03-29T03:30' }).errors.startsAt).toBeUndefined()
  })
})
