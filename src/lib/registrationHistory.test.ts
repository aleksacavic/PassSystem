import { describe, expect, it } from 'vitest'
import { registrationHistory } from './registrationHistory'

describe('registrationHistory', () => {
  it('counts per hour in the event time zone and fills empty hours with zero', () => {
    const h = registrationHistory(
      ['2026-10-29T10:05:00Z', '2026-10-29T10:40:00Z', '2026-10-29T13:10:00Z'],
      'Asia/Dubai', // UTC+4
    )
    expect(h.unit).toBe('hour')
    expect(h.buckets.map((b) => [b.label, b.count])).toEqual([
      ['14:00', 2],
      ['15:00', 0],
      ['16:00', 0],
      ['17:00', 1],
    ])
    expect(h.total).toBe(3)
    expect(h.peak?.title).toBe('29 Oct, 14:00–15:00')
  })

  it('switches to days for spans longer than two days, by the local date', () => {
    const h = registrationHistory(
      ['2026-10-25T21:00:00Z', '2026-10-26T09:00:00Z', '2026-10-29T08:00:00Z'],
      'Asia/Dubai', // 25th 21:00Z is already the 26th in Dubai
    )
    expect(h.unit).toBe('day')
    expect(h.buckets.map((b) => [b.key, b.count])).toEqual([
      ['2026-10-26', 2],
      ['2026-10-27', 0],
      ['2026-10-28', 0],
      ['2026-10-29', 1],
    ])
    expect(h.peak?.key).toBe('2026-10-26')
  })

  it('handles a half-hour zone and a daylight-saving change without gaps or duplicates', () => {
    const india = registrationHistory(['2026-10-29T08:10:00Z', '2026-10-29T09:20:00Z'], 'Asia/Kolkata')
    expect(india.buckets.map((b) => [b.label, b.count])).toEqual([
      ['13:00', 1],
      ['14:00', 1],
    ])
    // Europe/Belgrade leaves summer time at 01:00Z on 25 Oct 2026: 02:00 local happens twice.
    const dst = registrationHistory(['2026-10-24T23:30:00Z', '2026-10-25T02:30:00Z'], 'Europe/Belgrade')
    const keys = dst.buckets.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(dst.buckets.reduce((n, b) => n + b.count, 0)).toBe(2)
  })

  it('returns nothing for no registrations and ignores unreadable dates', () => {
    expect(registrationHistory([], 'UTC')).toEqual({ unit: 'hour', buckets: [], total: 0, peak: null })
    expect(registrationHistory(['not a date', '2026-10-29T10:00:00Z'], 'UTC').total).toBe(1)
  })
})

describe('registrationHistory edges (R17-03, R17-04)', () => {
  it('a fractional-offset zone starts at the first registration, with no empty period before it', () => {
    // 08:40Z is 14:10 in Kolkata (UTC+5:30); 08:10Z is 13:40, just before the half-hour boundary.
    expect(registrationHistory(['2026-10-29T08:40:00Z'], 'Asia/Kolkata').buckets.map((b) => b.label)).toEqual(
      ['14:00'],
    )
    expect(registrationHistory(['2026-10-29T08:10:00Z'], 'Asia/Kolkata').buckets.map((b) => b.label)).toEqual(
      ['13:00'],
    )
    // Kathmandu (UTC+5:45), and a daily chart starting just after local midnight.
    expect(
      registrationHistory(['2026-10-29T08:20:00Z'], 'Asia/Kathmandu').buckets.map((b) => b.label),
    ).toEqual(['14:00'])
    const daily = registrationHistory(['2026-10-28T18:40:00Z', '2026-11-02T10:00:00Z'], 'Asia/Kolkata')
    expect(daily.buckets[0]).toMatchObject({ key: '2026-10-29', count: 1 }) // 00:10 local on the 29th
  })

  it('handles a very large number of timestamps without throwing', () => {
    const many = Array(200_000).fill('2026-10-29T10:00:00Z')
    const h = registrationHistory(many, 'Asia/Dubai')
    expect(h.total).toBe(200_000)
    expect(h.buckets).toHaveLength(1)
  })

  it('names the year when the chart spans more than one', () => {
    const h = registrationHistory(['2026-12-30T10:00:00Z', '2027-01-02T10:00:00Z'], 'UTC')
    expect(h.buckets[0]!.title).toBe('30 Dec 2026')
    expect(h.buckets.at(-1)!.title).toBe('2 Jan 2027')
  })
})
