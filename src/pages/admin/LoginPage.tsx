import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { siteOrigin } from '../../lib/env'
import { safeNext } from '../../lib/nav'
import { supabase } from '../../lib/supabase'
import { LogoMark } from '../../components/Logo'
import { Alert, Button, Card, Field, Input, PageSpinner } from '../../components/ui'

export default function LoginPage() {
  const { session, loading } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'reset'>('login')

  if (loading) return <PageSpinner />
  if (session) return <Navigate to={next} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) {
          setError(
            /invalid login credentials/i.test(error.message)
              ? 'Incorrect email or password.'
              : /fetch/i.test(error.message)
                ? 'Network error. Check your connection.'
                : error.message,
          )
        }
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${siteOrigin()}/account`,
        })
        if (error && !/rate limit/i.test(error.message)) setError(error.message)
        else setInfo('If an account exists for that address, a password reset link has been sent.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 className="mt-3 text-2xl font-bold tracking-tight">Staff sign in</h1>
          <p className="mt-1 text-sm text-ink-600">For organizers and door operators.</p>
        </div>
        <Card className="p-5">
          <form className="space-y-4" onSubmit={onSubmit}>
            <Field label="Email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            {mode === 'login' && (
              <Field label="Password">
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
            )}
            {error && <Alert tone="bad">{error}</Alert>}
            {info && <Alert tone="ok">{info}</Alert>}
            <Button type="submit" block size="lg" loading={busy}>
              {mode === 'login' ? 'Sign in' : 'Send reset link'}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 w-full text-center text-sm font-semibold text-accent-600 hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'reset' : 'login')
              setError(null)
              setInfo(null)
            }}
          >
            {mode === 'login' ? 'Forgot password?' : 'Back to sign in'}
          </button>
        </Card>
        <p className="mt-6 text-center text-xs text-ink-500">
          Accounts are created by an administrator. Attendees do not need an account.
        </p>
      </div>
    </div>
  )
}
