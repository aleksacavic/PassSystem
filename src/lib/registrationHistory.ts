/**
 * How many things happened when (registrations, check-ins), counted per hour or
 * per day in the event's time zone, with empty periods filled in so gaps show
 * as zero.
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

/** Formatters are expensive to build: one per zone and locale, reused for every timestamp (R17-04). */
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(key: string, make: () => Intl.DateTimeFormat) {
  let f = formatters.get(key)
  if (!f) formatters.set(key, (f = make()))
  return f
}

function parts(ms: number, timeZone: string) {
  const f = formatter(
    `parts|${timeZone}`,
    () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      }),
  )
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(ms)) p[x.type] = x.value
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour! }
}

function keyFor(ms: number, unit: 'hour' | 'day', timeZone: string): string {
  const { day, hour } = parts(ms, timeZone)
  return unit === 'day' ? day : `${day}T${hour}`
}

function labels(ms: number, unit: 'hour' | 'day', timeZone: string, locale: string, withYear: boolean) {
  const date = formatter(`date|${timeZone}|${locale}|${withYear}`, () =>
    withYear
      ? new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: 'short', day: 'numeric' })
      : new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric' }),
  ).format(ms)
  if (unit === 'day') return { label: date, title: date }
  const hour = parts(ms, timeZone).hour
  const next = String((Number(hour) + 1) % 24).padStart(2, '0')
  return { label: `${hour}:00`, title: `${date}, ${hour}:00–${next}:00` }
}

export function registrationHistory(
  timestamps: string[],
  timeZone: string,
  locale = 'en-GB',
): RegistrationHistory {
  // A loop, not Math.min(...times): spreading a very large array exceeds the engine's argument limit (R17-04).
  let first = Infinity
  let last = -Infinity
  const times: number[] = []
  for (const t of timestamps) {
    const ms = Date.parse(t)
    if (Number.isNaN(ms)) continue
    times.push(ms)
    if (ms < first) first = ms
    if (ms > last) last = ms
  }
  if (times.length === 0) return { unit: 'hour', buckets: [], total: 0, peak: null }
  const unit = last - first <= HOURLY_MAX_SPAN ? 'hour' : 'day'
  const withYear = parts(first, timeZone).day.slice(0, 4) !== parts(last, timeZone).day.slice(0, 4)

  const counts = new Map<string, number>()
  /** One moment inside each counted period, to label it if the walk below misses it. */
  const sample = new Map<string, number>()
  for (const t of times) {
    const k = keyFor(t, unit, timeZone)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    if (!sample.has(k)) sample.set(k, t)
  }

  // Walk the span hour by hour (in UTC) and collect each local period once, so
  // daylight-saving changes and fractional-offset zones still give one bucket per
  // period. Periods before the first or after the last one are left out (R17-03).
  const firstKey = keyFor(first, unit, timeZone)
  const lastKey = keyFor(last, unit, timeZone)
  const buckets: HistoryBucket[] = []
  const seen = new Set<string>()
  for (let t = Math.floor(first / HOUR) * HOUR; t <= last + HOUR; t += HOUR) {
    const k = keyFor(t, unit, timeZone)
    if (seen.has(k) || k < firstKey || k > lastKey) continue
    seen.add(k)
    buckets.push({ key: k, ...labels(t, unit, timeZone, locale, withYear), count: counts.get(k) ?? 0 })
  }
  // A local period shorter than an hour (a half-hour daylight-saving jump, as on Lord
  // Howe Island) can fall between two whole-hour steps: add every counted period the walk
  // missed, so the bars always add up to the total (R18-01).
  for (const [k, count] of counts)
    if (!seen.has(k)) {
      seen.add(k)
      buckets.push({ key: k, ...labels(sample.get(k)!, unit, timeZone, locale, withYear), count })
    }
  buckets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  let peak: HistoryBucket | null = null
  for (const b of buckets) if (!peak || b.count > peak.count) peak = b
  return { unit, buckets, total: times.length, peak }
}
