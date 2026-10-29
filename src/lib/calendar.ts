// "Add to calendar": an iCalendar (.ics) file for the event, with the pass link
// in the notes so the QR code is one tap away on the day. Works with Apple,
// Google and Outlook calendars; no account or setup needed.

export interface CalendarEvent {
  uid: string
  title: string
  startsAt: string
  endsAt?: string | null
  location?: string | null
  description?: string
  url?: string
}

/**
 * RFC 5545 text escaping. Every line break (CRLF, CR or LF) becomes an escaped \n, and
 * other control characters, which TEXT values cannot contain, are dropped.
 */
function escapeText(value: string): string {
  return (
    value
      .replace(/\r\n?|\n/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
  )
}

function utcStamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Lines longer than 75 octets are folded (CRLF + space). */
function fold(line: string): string {
  const bytes = new TextEncoder()
  if (bytes.encode(line).length <= 75) return line
  const out: string[] = []
  let current = ''
  for (const ch of line) {
    if (bytes.encode(current + ch).length > (out.length ? 74 : 75)) {
      out.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  out.push(current)
  return out.join('\r\n ')
}

export function buildIcs(ev: CalendarEvent, now = new Date()): string {
  // Events without an end time get three hours, so the calendar shows a block.
  const end = ev.endsAt ?? new Date(new Date(ev.startsAt).getTime() + 3 * 3600_000).toISOString()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PassSystem//Pass//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(ev.uid)}`,
    `DTSTAMP:${utcStamp(now.toISOString())}`,
    `DTSTART:${utcStamp(ev.startsAt)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${escapeText(ev.location)}`] : []),
    ...(ev.description ? [`DESCRIPTION:${escapeText(ev.description)}`] : []),
    ...(ev.url ? [`URL:${ev.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

export function downloadIcs(ics: string, filename: string): void {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
