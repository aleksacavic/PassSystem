import { describe, expect, it } from 'vitest'
import { isoToZonedInput, isValidTimeZone, zonedInputToIso, zoneOffsetMs } from './datetime'

describe('time zone conversion', () => {
  it('converts wall time in a zone to UTC', () => {
    expect(zonedInputToIso('2026-11-20T18:00', 'UTC')).toBe('2026-11-20T18:00:00.000Z')
    expect(zonedInputToIso('2026-11-20T18:00', 'Europe/Belgrade')).toBe('2026-11-20T17:00:00.000Z') // CET
    expect(zonedInputToIso('2026-07-01T18:00', 'Europe/Belgrade')).toBe('2026-07-01T16:00:00.000Z') // CEST
    expect(zonedInputToIso('2026-07-01T09:30', 'America/New_York')).toBe('2026-07-01T13:30:00.000Z')
    expect(zonedInputToIso('2026-07-01T09:30', 'Asia/Kolkata')).toBe('2026-07-01T04:00:00.000Z')
  })
  it('round-trips through datetime-local values', () => {
    for (const tz of ['UTC', 'Europe/Belgrade', 'America/Los_Angeles', 'Australia/Sydney']) {
      const iso = zonedInputToIso('2026-03-29T12:15', tz)!
      expect(isoToZonedInput(iso, tz)).toBe('2026-03-29T12:15')
    }
  })
  it('handles DST transition days', () => {
    // Europe DST starts 2026-03-29 02:00 -> 03:00
    expect(zonedInputToIso('2026-03-29T03:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z')
    expect(zoneOffsetMs(new Date('2026-03-29T00:00:00Z'), 'Europe/Berlin')).toBe(3600_000)
    expect(zoneOffsetMs(new Date('2026-03-29T02:00:00Z'), 'Europe/Berlin')).toBe(7200_000)
  })
  it('rejects bad input', () => {
    expect(zonedInputToIso('', 'UTC')).toBeNull()
    expect(zonedInputToIso('tomorrow', 'UTC')).toBeNull()
    expect(isoToZonedInput(null, 'UTC')).toBe('')
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('Europe/Belgrade')).toBe(true)
  })
})
