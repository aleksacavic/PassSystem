import { describe, expect, it } from 'vitest'
import { buildIcs } from './calendar'

describe('buildIcs', () => {
  const base = {
    uid: 'pass-abc@passsystem',
    title: 'Autumn Gala, Night; "VIP"',
    startsAt: '2026-11-06T16:00:00.000Z',
    endsAt: '2026-11-06T21:00:00.000Z',
    location: 'Yas Island, Abu Dhabi',
    description: 'Your pass: https://passsystem-phi.vercel.app/pass#87J813AZE9GZXK95NP3GA5F4',
    url: 'https://passsystem-phi.vercel.app/pass#87J813AZE9GZXK95NP3GA5F4',
  }

  it('produces a valid single-event calendar in UTC with escaped text', () => {
    const ics = buildIcs(base, new Date('2026-10-28T10:00:00Z'))
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics).toContain('DTSTART:20261106T160000Z')
    expect(ics).toContain('DTEND:20261106T210000Z')
    expect(ics).toContain('DTSTAMP:20261028T100000Z')
    expect(ics).toContain('SUMMARY:Autumn Gala\\, Night\\; "VIP"')
    expect(ics).toContain('LOCATION:Yas Island\\, Abu Dhabi')
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true)
  })

  it('folds long lines at 75 octets and defaults the end to three hours', () => {
    const ics = buildIcs({ ...base, endsAt: null, description: 'x'.repeat(200) })
    expect(ics).toContain('DTEND:20261106T190000Z')
    for (const line of ics.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain(`DESCRIPTION:${'x'.repeat(200)}`)
  })

  it('folds multi-byte text without splitting characters', () => {
    const ics = buildIcs({ ...base, title: 'أمسية الخريف '.repeat(8) })
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain(`SUMMARY:${'أمسية الخريف '.repeat(8)}`)
  })
})
