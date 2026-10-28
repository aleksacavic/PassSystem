import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import {
  checkCfHeaderSpoofable,
  diagnoseClientIp,
  inviteStaff,
  publicSignupEnabled,
  listProfiles,
  setUserAdmin,
  type ClientIpDiagnosis,
} from '../../lib/api'
import { validateEmail } from '../../lib/validation'
import { formatDateTime } from '../../lib/datetime'
import type { Profile } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui'

export default function UsersPage() {
  const { session } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ipCheck, setIpCheck] = useState<ClientIpDiagnosis | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteDone, setInviteDone] = useState<string | null>(null)
  const [signupOpen, setSignupOpen] = useState<boolean | null>(null)
  const [spoof, setSpoof] = useState<{ spoofable: boolean } | 'running' | 'failed' | null>(null)

  const load = useCallback(() => {
    listProfiles()
      .then(setUsers)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    diagnoseClientIp()
      .then(setIpCheck)
      .catch(() => undefined)
    publicSignupEnabled().then(setSignupOpen)
  }, [])

  async function runSpoofCheck() {
    setSpoof('running')
    try {
      setSpoof(await checkCfHeaderSpoofable())
    } catch {
      setSpoof('failed')
    }
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault()
    setInviteError(null)
    setInviteDone(null)
    const email = inviteEmail.trim().toLowerCase()
    const invalid = email ? validateEmail(email) : 'Enter an email address.'
    if (invalid) return setInviteError(invalid)
    setInviting(true)
    try {
      const res = await inviteStaff(email, inviteAdmin)
      setInviteDone(
        res.warning ??
          `Invite sent to ${res.email}${res.admin ? ' as administrator' : ''}. They choose a password from the email link.`,
      )
      setInviteEmail('')
      setInviteAdmin(false)
      load()
    } catch (err) {
      setInviteError((err as Error).message)
    } finally {
      setInviting(false)
    }
  }

  async function toggle(u: Profile) {
    const verb = u.is_admin ? 'Remove administrator rights from' : 'Make administrator:'
    if (!window.confirm(`${verb} ${u.email}?`)) return
    try {
      await setUserAdmin(u.id, !u.is_admin)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Staff accounts"
        description="Everyone who can sign in. Assign people to events from each event’s Staff tab."
      />
      {signupOpen && (
        <Alert tone="bad" title="Public sign-up is switched on" className="mb-5">
          Anyone can create an account. In Supabase, open Authentication → Sign In / Providers and turn off
          “Allow new users to sign up”.
        </Alert>
      )}
      <Card className="mb-6 p-5">
        <h2 className="text-base font-semibold">Invite staff</h2>
        <p className="mt-1 text-sm text-ink-600">
          They receive an email, choose a password, and can then be assigned to events from each event’s Staff
          tab.
        </p>
        <form className="mt-4 space-y-4" onSubmit={onInvite} noValidate>
          <Field label="Email">
            {(p) => (
              <Input
                {...p}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            )}
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <input
              id="invite-admin"
              type="checkbox"
              className="mt-0.5 size-5 rounded border-ink-300 accent-ink-900"
              checked={inviteAdmin}
              onChange={(e) => setInviteAdmin(e.target.checked)}
            />
            <span>
              <span className="font-semibold">Administrator</span>
              <span className="block text-ink-500">
                Full access to every event, can create events and invite staff.
              </span>
            </span>
          </label>
          {inviteError && <Alert tone="bad">{inviteError}</Alert>}
          {inviteDone && <Alert tone="ok">{inviteDone}</Alert>}
          <Button type="submit" loading={inviting}>
            Send invite
          </Button>
        </form>
      </Card>
      {error && (
        <Alert tone="bad" className="mb-4">
          {error}
        </Alert>
      )}
      <Card>
        {!users ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{u.email}</p>
                  <p className="text-xs text-ink-500">Added {formatDateTime(u.created_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!u.confirmed_at && <Badge tone="warn">Invite pending</Badge>}
                  {u.is_admin ? <Badge tone="accent">Administrator</Badge> : <Badge>Staff</Badge>}
                  {u.id !== session?.user.id && (u.confirmed_at || u.is_admin) && (
                    <Button variant="ghost" size="sm" onClick={() => toggle(u)}>
                      {u.is_admin ? 'Remove admin' : 'Make admin'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {ipCheck && (
        <p className="mt-4 text-xs text-ink-500" data-testid="ip-check">
          Deployment check — rate limiting identifies clients by: <strong>{ipCheck.source}</strong>
          {ipCheck.source === 'cf-connecting-ip'
            ? ' (expected on Supabase Cloud)'
            : ipCheck.source === 'x-real-ip'
              ? ' (expected on the local stack; on Supabase Cloud expect cf-connecting-ip)'
              : ' — check your proxy configuration (see README).'}
          {ipCheck.cf_connecting_ip_present &&
            !ipCheck.trust_cf_connecting_ip &&
            ' (Cloudflare header present but not yet trusted)'}
          {' · '}
          <button type="button" className="font-semibold text-accent-600 underline" onClick={runSpoofCheck}>
            Test header spoofing
          </button>
          {spoof === 'running' && ' …'}
          {spoof === 'failed' && ' — could not run the test.'}
          {spoof && typeof spoof === 'object' && (
            <span data-testid="spoof-result">
              {spoof.spoofable
                ? ' — FORGEABLE: clients can fake cf-connecting-ip here; it must not be trusted.'
                : ' — safe: forged cf-connecting-ip values are replaced by the proxy.'}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
