import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { RequireAuth } from './auth/RequireAuth'
import { AdminLayout } from './components/AdminLayout'
import { PageSpinner } from './components/ui'
import { env } from './lib/env'
import { LangProvider } from './components/LangProvider'
import HomePage from './pages/public/HomePage'
import RegisterPage from './pages/public/RegisterPage'
import PassPage from './pages/public/PassPage'
import NotFoundPage from './pages/public/NotFoundPage'
import RouteErrorPage from './pages/public/RouteErrorPage'

// Staff-only code is split out so the attendee pages stay small on mobile networks.
const LoginPage = lazy(() => import('./pages/admin/LoginPage'))
const InvitePage = lazy(() => import('./pages/admin/InvitePage'))
const AccountPage = lazy(() => import('./pages/admin/AccountPage'))
const EventsPage = lazy(() => import('./pages/admin/EventsPage'))
const EventFormPage = lazy(() => import('./pages/admin/EventFormPage'))
const EventDetailPage = lazy(() => import('./pages/admin/EventDetailPage'))
const UsersPage = lazy(() => import('./pages/admin/UsersPage'))
const ScanPage = lazy(() => import('./pages/scan/ScanPage'))

function Lazy() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Outlet />
    </Suspense>
  )
}

/** Invite and password-recovery links land on the site root: send them to the password form. */
function Root() {
  const { session, needsPassword } = useAuth()
  const { pathname } = useLocation()
  if (session && needsPassword && pathname !== '/account') return <Navigate to="/account" replace />
  return <Outlet />
}

function StaffArea() {
  return (
    <RequireAuth>
      <AdminLayout />
    </RequireAuth>
  )
}

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        // Guest pages: English or Arabic (right-to-left).
        element: (
          <LangProvider>
            <Outlet />
          </LangProvider>
        ),
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/e/:slug', element: <RegisterPage /> },
          { path: '/pass', element: <PassPage /> },
        ],
      },
      {
        element: <Lazy />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/invite', element: <InvitePage /> },
          {
            element: <StaffArea />,
            children: [
              { path: '/admin', element: <EventsPage /> },
              { path: '/admin/events/new', element: <EventFormPage /> },
              { path: '/admin/events/:id', element: <EventDetailPage /> },
              { path: '/admin/events/:id/edit', element: <EventFormPage /> },
              {
                path: '/admin/users',
                element: (
                  <RequireAuth admin>
                    <UsersPage />
                  </RequireAuth>
                ),
              },
              { path: '/account', element: <AccountPage /> },
              { path: '/scan', element: <ScanPage /> },
              { path: '/scan/:eventId', element: <ScanPage /> },
            ],
          },
        ],
      },
      { path: '/admin/*', element: <Navigate to="/admin" replace /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

export default function App() {
  if (!env.configured) {
    return (
      <div className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-bold">PassSystem is not configured</h1>
        <p className="mt-2 text-fg-muted">
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> and rebuild. See
          README.
        </p>
      </div>
    )
  }
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
