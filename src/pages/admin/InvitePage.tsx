import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../../auth/AuthProvider'
import { acceptInvite } from '../../lib/api'
import { LogoMark } from '../../components/Logo'
import { Alert, Button, Card } from '../../components/ui'

// Read once: the token stays out of server logs and link previews because it
// is in the URL fragment, and it is only redeemed when the person presses Accept.
function tokenFromHash(): string | null {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
  return token && /^[A-Za-z0-9_-]{10,200}$/.test(token) ? token : null
}

/** Landing page of an invite link shared by an administrator (no email involved). */
export default function InvitePage() {
  const { session, markNeedsPassword } = useAuth()
  const navigate = useNavigate()
  const [token] = useState(tokenFromHash)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAccept() {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      await acceptInvite(token)
      markNeedsPassword()
      window.history.replaceState(null, '', '/invite')
      navigate('/account', { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 className="mt-3 text-2xl font-bold tracking-tight">You’re invited to PassSystem</h1>
          <p className="mt-1 text-sm text-ink-600">Accept to join the event team and choose your password.</p>
        </div>
        <Card className="space-y-4 p-5">
          {!token ? (
            <Alert tone="bad">This invite link is incomplete. Ask your administrator to send it again.</Alert>
          ) : (
            <>
              {session && (
                <Alert tone="warn">
                  You are signed in as {session.user.email}. Accepting signs you in as the invited person
                  instead.
                </Alert>
              )}
              {error && <Alert tone="bad">{error}</Alert>}
              <Button block size="lg" loading={busy} onClick={onAccept}>
                Accept invite
              </Button>
              <p className="text-center text-xs text-ink-500">The link works once.</p>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
