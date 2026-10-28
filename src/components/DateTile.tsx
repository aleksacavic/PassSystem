import { dateParts } from '../lib/datetime'
import { cx } from './ui'

/** Calendar-page tile: "NOV / 06" in the event's time zone. */
export function DateTile({
  iso,
  timeZone,
  locale,
  tone = 'surface',
  className,
}: {
  iso: string
  timeZone?: string | null
  locale?: string
  tone?: 'surface' | 'brand' | 'muted'
  className?: string
}) {
  const { month, day } = dateParts(iso, timeZone, locale)
  return (
    <div
      className={cx(
        'flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-control',
        tone === 'surface' && 'bg-surface shadow-raised',
        tone === 'brand' && 'bg-brand-soft',
        tone === 'muted' && 'bg-surface-sunk',
        className,
      )}
      aria-hidden="true"
    >
      <span
        className={cx(
          'text-[10px] font-extrabold tracking-[0.12em]',
          tone === 'muted' ? 'text-fg-subtle' : 'text-brand',
        )}
      >
        {month}
      </span>
      <span className={cx('text-2xl leading-none font-extrabold', tone === 'brand' && 'text-primary')}>
        {day}
      </span>
    </div>
  )
}
