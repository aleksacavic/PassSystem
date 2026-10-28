import type { ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { CalendarDays, CircleUserRound, LogOut, ScanLine, Users, type LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Logo } from './Logo'
import { Button, IconButton, cx } from './ui'

interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
  /** Also active on these path prefixes (e.g. an event's own pages for "Events"). */
  also?: string[]
}

function useIsActive(entry: NavEntry) {
  const { pathname } = useLocation()
  if (pathname === entry.to) return true
  return [...(entry.to === '/admin' ? [] : [entry.to]), ...(entry.also ?? [])].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
}

function useNavEntries(): NavEntry[] {
  const { isAdmin } = useAuth()
  return [
    { to: '/admin', label: 'Events', icon: CalendarDays, also: ['/admin/events'] },
    { to: '/scan', label: 'Scan', icon: ScanLine },
    ...(isAdmin ? [{ to: '/admin/users', label: 'Staff', icon: Users }] : []),
    { to: '/account', label: 'Account', icon: CircleUserRound },
  ]
}

/** Desktop: icon + label pills in the top bar. */
function TopNavItem(entry: NavEntry) {
  const { to, label, icon: Icon } = entry
  const isActive = useIsActive(entry)
  return (
    <Link
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={cx(
        'inline-flex items-center gap-2 rounded-control px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors',
        isActive
          ? 'bg-(--nav-active-bg) text-(--nav-active-fg)'
          : 'text-(--nav-idle-fg) hover:bg-surface-muted hover:text-fg',
      )}
    >
      <Icon className="size-[18px]" aria-hidden="true" />
      {label}
    </Link>
  )
}

/** Phones: icon over label in a bottom tab bar. */
function TabItem(entry: NavEntry) {
  const { to, label, icon: Icon } = entry
  const isActive = useIsActive(entry)
  return (
    <Link
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={cx(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold',
        isActive ? 'text-(--nav-active-fg)' : 'text-(--nav-idle-fg)',
      )}
    >
      <span
        className={cx(
          'flex h-7 w-12 items-center justify-center rounded-pill transition-colors',
          isActive && 'bg-(--nav-active-bg)',
        )}
      >
        <Icon className="size-5" aria-hidden="true" strokeWidth={isActive ? 2.4 : 2} />
      </span>
      <span className="truncate">{label}</span>
    </Link>
  )
}

export function AdminLayout() {
  const { profile, signOut } = useAuth()
  const entries = useNavEntries()
  // The door scanner runs in the dark theme (dim venues, less glare).
  const night = useLocation().pathname.startsWith('/scan')
  return (
    <div className={cx('min-h-dvh', night && 'theme-night')} data-theme-night={night || undefined}>
      <header className="no-print sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-(--nav-height) max-w-6xl items-center gap-3 px-4">
          <Logo to="/admin" wordmark="desktop" />
          <nav className="ml-3 hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
            {entries.map((e) => (
              <TopNavItem key={e.to} {...e} />
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span
              className="hidden max-w-48 truncate text-sm text-fg-subtle sm:inline"
              title={profile?.email ?? ''}
            >
              {profile?.email}
            </span>
            <span className="hidden md:block">
              <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void signOut()}>
                Sign out
              </Button>
            </span>
            <span className="md:hidden">
              <IconButton icon={LogOut} label="Sign out" size="sm" onClick={() => void signOut()} />
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-6 pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+1.5rem)] md:pb-8">
        <Outlet />
      </main>
      <nav
        aria-label="Main"
        className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-tabbar backdrop-blur md:hidden"
      >
        <div className="flex h-(--tabbar-height) w-full">
          {entries.map((e) => (
            <TabItem key={e.to} {...e} />
          ))}
        </div>
      </nav>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  back?: ReactNode
}) {
  return (
    <div className="mb-6 space-y-2">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight break-words">{title}</h1>
          {description && <div className="mt-1 text-fg-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  )
}
