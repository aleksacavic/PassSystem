import { useRef, type KeyboardEvent } from 'react'
import { cx } from './cx'

/**
 * A small set of mutually exclusive options (filters, view switches).
 * Keyboard: a radio group — one Tab stop (the selected option), arrow keys
 * move and select, Home/End jump to the ends.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = options.length - 1
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? current === last
          ? 0
          : current + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? current === 0
            ? last
            : current - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        'inline-flex rounded-control bg-surface-muted p-1 ring-1 ring-inset ring-line-soft',
        className,
      )}
    >
      {options.map((o, i) => {
        const active = i === current
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-(--control-sm) rounded-[calc(var(--radius-control)-0.25rem)] px-3 text-sm font-semibold whitespace-nowrap transition-colors',
              active ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
