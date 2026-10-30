import { ChevronDown } from 'lucide-react'
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cx } from './cx'

const control =
  'block w-full rounded-control border-0 bg-surface px-3.5 py-2.5 text-base text-fg shadow-card ring-1 ring-inset ring-line placeholder:text-fg-faint focus:ring-2 focus:ring-inset focus:ring-brand-bright focus:outline-none disabled:bg-surface-muted disabled:text-fg-subtle aria-invalid:ring-2 aria-invalid:ring-danger min-h-(--control-input)'

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** true shows 'Optional'; a string shows that text instead (translations). */
  optional?: boolean | string
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
  className?: string
}

export function Field({ label, hint, error, optional, children, className }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="flex items-baseline justify-between text-sm font-semibold text-fg">
        <span>{label}</span>
        {optional && (
          <span className="text-xs font-normal text-fg-subtle">
            {typeof optional === 'string' ? optional : 'Optional'}
          </span>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-fg-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(control, className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(control, 'min-h-24', className)} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...rest },
  ref,
) {
  // The browser's own arrow sits on the very edge of the field; draw our own chevron with room around it.
  return (
    <div className="relative">
      <select ref={ref} className={cx(control, 'appearance-none pe-11', className)} {...rest} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-4 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
      />
    </div>
  )
})
