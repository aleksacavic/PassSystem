import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { useAuth } from '../auth/AuthProvider'
import { Logo } from './Logo'
import { Button, cx } from './ui'

function NavItem({ to, children, end }: { to: string; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap',
          isActive ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
        )
      }
    >
      {children}
    </NavLink>
  )
}

export function AdminLayout() {
  const { profile, isAdmin, signOut } = useAuth()
  return (
    <div className="min-h-dvh">
      <header className="no-print sticky top-0 z-20 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Logo to="/admin" />
          <nav className="ml-2 flex flex-1 items-center gap-1 overflow-x-auto" aria-label="Main">
            <NavItem to="/admin" end>
              Events
            </NavItem>
            <NavItem to="/scan">Scan</NavItem>
            {isAdmin && <NavItem to="/admin/users">Staff</NavItem>}
            <NavItem to="/account">Account</NavItem>
          </nav>
          <span
            className="hidden max-w-48 truncate text-sm text-ink-500 md:inline"
            title={profile?.email ?? ''}
          >
            {profile?.email}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
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
          {description && <div className="mt-1 text-ink-600">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  )
}
