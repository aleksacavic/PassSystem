/** Time-zone aware helpers built on Intl (no external date library). */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function partsInZone(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const out: Record<string, number> = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * Convert a wall-clock value from <input type="datetime-local"> ("YYYY-MM-DDTHH:mm")
 * interpreted in `timeZone` into an ISO-8601 UTC string. Returns null for empty/invalid input.
 */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  let ts = guess - zoneOffsetMs(new Date(guess), timeZone)
  const second = zoneOffsetMs(new Date(ts), timeZone)
  if (guess - second !== ts) ts = guess - second
  return new Date(ts).toISOString()
}

/**
 * False for wall-clock times skipped by a daylight-saving change (e.g. 02:30 on
 * the spring-forward night), which would otherwise be shifted silently.
 */
export function zonedInputExists(value: string, timeZone: string): boolean {
  const iso = zonedInputToIso(value, timeZone)
  return iso !== null && isoToZonedInput(iso, timeZone) === value.trim().slice(0, 16)
}

/** Format an ISO timestamp as a datetime-local value in `timeZone`. */
export function isoToZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const p = partsInZone(date, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

function safeZone(tz?: string | null): string | undefined {
  return tz && isValidTimeZone(tz) ? tz : undefined
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: safeZone(timeZone),
  }).format(date)
}

export function formatEventDate(
  startsAt: string,
  endsAt: string | null | undefined,
  timeZone?: string | null,
): string {
  const tz = safeZone(timeZone)
  const start = new Date(startsAt)
  const full = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  })
  if (!endsAt) return full.format(start)
  const end = new Date(endsAt)
  const sameDay =
    isoToZonedInput(startsAt, tz ?? 'UTC').slice(0, 10) === isoToZonedInput(endsAt, tz ?? 'UTC').slice(0, 10)
  if (sameDay) {
    const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz })
    return `${full.format(start)} – ${time.format(end)}`
  }
  return `${full.format(start)} – ${full.format(end)}`
}

export function formatTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: safeZone(timeZone),
  }).format(new Date(iso))
}

/** Short zone label such as "CET" or "GMT+2" for display next to times. */
export function zoneLabel(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(
      new Date(iso),
    )
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}
