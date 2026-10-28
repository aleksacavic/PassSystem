import { Link } from 'react-router'

export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect x="7" y="7" width="7" height="7" rx="1.5" className="fill-on-primary" />
      <rect x="18" y="7" width="7" height="7" rx="1.5" className="fill-on-primary" />
      <rect x="7" y="18" width="7" height="7" rx="1.5" className="fill-on-primary" />
      <path
        d="M18.5 22.2l2.3 2.3 4.7-5"
        className="stroke-success-bright"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Logo({ to = '/', wordmark = 'always' }: { to?: string; wordmark?: 'always' | 'desktop' }) {
  return (
    <Link
      to={to}
      aria-label="PassSystem home"
      className="inline-flex items-center gap-2 font-bold tracking-tight text-fg"
    >
      <LogoMark />
      <span className={wordmark === 'desktop' ? 'hidden md:inline' : undefined}>PassSystem</span>
    </Link>
  )
}
