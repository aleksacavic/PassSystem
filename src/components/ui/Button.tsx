import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Link, type LinkProps } from 'react-router'
import { cx } from './cx'
import { buttonClass, type Size, type Variant } from './buttonStyles'
import { Spinner } from './Spinner'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading,
    block,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, cx(block && 'w-full', className))}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  )
})

interface ButtonLinkProps extends LinkProps {
  variant?: Variant
  size?: Size
  block?: boolean
}

export function ButtonLink({ variant = 'primary', size = 'md', block, className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, size, cx(block && 'w-full', className as string))} {...rest} />
}
