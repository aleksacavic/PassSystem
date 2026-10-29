/**
 * Registrations over time, counted per hour or per day in the event's time
 * zone, with empty periods filled in so gaps show as zero.
 */
export interface HistoryBucket {
  /** Sortable key in the event's time zone: "2026-10-29" or "2026-10-29T14". */
  key: string
  /** Short axis label, e.g. "Oct 29" or "14:00". */
  label: string
  /** Full label for tooltips and the table, e.g. "Oct 29, 14:00–15:00". */
  title: string
  count: number
}

export interface RegistrationHistory {
  unit: 'hour' | 'day'
  buckets: HistoryBucket[]
  total: number
  /** The busiest bucket (the first one if several tie); null when there are none. */
  peak: HistoryBucket | null
}

const HOUR = 60 * 60 * 1000
/** Spans up to two days are shown per hour; longer ones per day. */
const HOURLY_MAX_SPAN = 48 * HOUR

function parts(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour! }
}

function keyFor(ms: number, unit: 'hour' | 'day', timeZone: string): string {
  const { day, hour } = parts(ms, timeZone)
  return unit === 'day' ? day : `${day}T${hour}`
}

function labels(ms: number, unit: 'hour' | 'day', timeZone: string, locale: string) {
  const date = new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric' }).format(ms)
  if (unit === 'day') return { label: date, title: date }
  const hour = parts(ms, timeZone).hour
  const next = String((Number(hour) + 1) % 24).padStart(2, '0')
  return { label: `${hour}:00`, title: `${date}, ${hour}:00–${next}:00` }
}

export function registrationHistory(
  registeredAt: string[],
  timeZone: string,
  locale = 'en-GB',
): RegistrationHistory {
  const times = registeredAt.map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t))
  if (times.length === 0) return { unit: 'hour', buckets: [], total: 0, peak: null }
  const first = Math.min(...times)
  const last = Math.max(...times)
  const unit = last - first <= HOURLY_MAX_SPAN ? 'hour' : 'day'

  const counts = new Map<string, number>()
  for (const t of times) {
    const k = keyFor(t, unit, timeZone)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }

  // Walk the span hour by hour (in UTC) and collect each local period once, so
  // daylight-saving changes and half-hour zones still give one bucket per period.
  const buckets: HistoryBucket[] = []
  const seen = new Set<string>()
  const start = Math.floor(first / HOUR) * HOUR
  for (let t = start; t <= last + HOUR; t += HOUR) {
    const k = keyFor(t, unit, timeZone)
    if (seen.has(k) || k > keyFor(last, unit, timeZone)) continue
    seen.add(k)
    buckets.push({ key: k, ...labels(t, unit, timeZone, locale), count: counts.get(k) ?? 0 })
  }
  // A local period that started before the first whole UTC hour (half-hour zones).
  const firstKey = keyFor(first, unit, timeZone)
  if (!seen.has(firstKey))
    buckets.unshift({
      key: firstKey,
      ...labels(first, unit, timeZone, locale),
      count: counts.get(firstKey) ?? 0,
    })

  const peak = buckets.reduce<HistoryBucket | null>(
    (best, b) => (!best || b.count > best.count ? b : best),
    null,
  )
  return { unit, buckets, total: times.length, peak }
}
