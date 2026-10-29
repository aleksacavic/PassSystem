import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { buttonClass } from './buttonStyles'
import { cx } from './cx'

export type MenuItem =
  { label: string; icon: LucideIcon; to: string } | { label: string; icon: LucideIcon; onSelect: () => void }

/**
 * "⋯" button with a small list of secondary actions. Closes on Escape and outside clicks.
 * The list opens toward the side with room, so it never runs off a phone screen.
 */
export function Menu({
  label,
  items,
  align = 'auto',
}: {
  label: string
  items: MenuItem[]
  align?: 'start' | 'end' | 'auto'
}) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<'start' | 'end'>(align === 'start' ? 'start' : 'end')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()

  // Pick the side before the list is painted: open toward the screen's centre.
  useLayoutEffect(() => {
    if (!open || align !== 'auto' || !root.current) return
    const r = root.current.getBoundingClientRect()
    const rtl = getComputedStyle(root.current).direction === 'rtl'
    const buttonOnLeft = r.left + r.width / 2 < window.innerWidth / 2
    // 'start' anchors the list's leading edge to the button and grows toward the end.
    setSide(buttonOnLeft !== rtl ? 'start' : 'end')
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus() // back to the ⋯ button, not the page
    }
    // A rotation or resize can move the button to the other half of the screen: close
    // rather than leave the list where it no longer fits (R19-02).
    const onResize = () => setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const itemClass =
    'flex w-full items-center gap-3 rounded-[calc(var(--radius-control)-0.25rem)] px-3 py-2.5 text-start text-[15px] font-semibold text-fg hover:bg-surface-muted focus-visible:bg-surface-muted [&_svg]:size-[18px] [&_svg]:text-fg-subtle'

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        className={buttonClass('secondary', 'md', undefined, true)}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className={cx(
            'absolute top-full z-30 mt-2 w-max max-w-[calc(100vw-2rem)] min-w-52 rounded-control bg-surface p-1.5 shadow-raised ring-1 ring-line',
            (align === 'auto' ? side : align) === 'end' ? 'end-0' : 'start-0',
          )}
        >
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.label}>
                {'to' in item ? (
                  <Link to={item.to} className={itemClass} onClick={() => setOpen(false)}>
                    <item.icon aria-hidden="true" />
                    {item.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={itemClass}
                    onClick={() => {
                      setOpen(false)
                      item.onSelect()
                    }}
                  >
                    <item.icon aria-hidden="true" />
                    {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
