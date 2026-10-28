import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { supabase } from '../../lib/supabase'
import { PageHeader } from '../../components/AdminLayout'
import { Alert, Badge, Button, Card, Field, Input } from '../../components/ui'

export default function AccountPage() {
  const { profile, isAdmin, needsPassword, clearNeedsPassword } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setDone(false)
    if (password.length < 10) return setError('Use at least 10 characters.')
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return setError('Use both letters and digits.')
    if (password !== confirm) return setError('Passwords do not match.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) return setError(error.message)
    setPassword('')
    setConfirm('')
    setDone(true)
    if (needsPassword) {
      clearNeedsPassword()
      navigate('/admin', { replace: true })
    }
  }

  return (
    <div className="max-w-lg">
      <PageHeader title="Account" />
      <Card className="mb-6 p-5">
        <p className="text-sm text-ink-500">Signed in as</p>
        <p className="font-semibold break-all">{profile?.email}</p>
        <div className="mt-2">
          {isAdmin ? <Badge tone="accent">Administrator</Badge> : <Badge>Staff</Badge>}
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="text-lg font-semibold">
          {needsPassword ? 'Choose your password' : 'Change password'}
        </h2>
        {needsPassword && (
          <p className="mt-1 text-sm text-ink-600">Set a password to finish activating your staff account.</p>
        )}
        <form className="mt-4 space-y-4" onSubmit={onSubmit}>
          <Field label="New password" hint="At least 10 characters with letters and digits.">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Field label="Confirm new password">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </Field>
          {error && <Alert tone="bad">{error}</Alert>}
          {done && <Alert tone="ok">Password updated.</Alert>}
          <Button type="submit" loading={busy}>
            Save password
          </Button>
        </form>
      </Card>
    </div>
  )
}
