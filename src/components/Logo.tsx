import { Link } from 'react-router'

export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#18181b" />
      <rect x="7" y="7" width="7" height="7" rx="1.5" fill="#fff" />
      <rect x="18" y="7" width="7" height="7" rx="1.5" fill="#fff" />
      <rect x="7" y="18" width="7" height="7" rx="1.5" fill="#fff" />
      <path
        d="M18.5 22.2l2.3 2.3 4.7-5"
        stroke="#4ade80"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-2 font-bold tracking-tight text-ink-900">
      <LogoMark />
      <span>PassSystem</span>
    </Link>
  )
}
