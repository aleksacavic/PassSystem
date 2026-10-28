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
  'block w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-base text-ink-900 shadow-sm ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:ring-2 focus:ring-inset focus:ring-accent-500 focus:outline-none disabled:bg-ink-100 disabled:text-ink-500 aria-invalid:ring-2 aria-invalid:ring-bad-600 min-h-12'

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  optional?: boolean
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
      <label htmlFor={id} className="flex items-baseline justify-between text-sm font-semibold text-ink-800">
        <span>{label}</span>
        {optional && <span className="text-xs font-normal text-ink-500">Optional</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-ink-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-bad-700" role="alert">
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
  return <select ref={ref} className={cx(control, 'pr-9', className)} {...rest} />
})
