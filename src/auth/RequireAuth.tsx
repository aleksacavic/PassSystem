import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { PageSpinner } from '../components/ui'
import { useAuth } from './AuthProvider'

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { loading, session, isAdmin, needsPassword, profileReady } = useAuth()
  const location = useLocation()
  if (loading) return <PageSpinner />
  if (!session) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }
  if (needsPassword && location.pathname !== '/account') return <Navigate to="/account" replace />
  if (admin) {
    if (!profileReady) return <PageSpinner />
    if (!isAdmin) return <Navigate to="/admin" replace />
  }
  return <>{children}</>
}
