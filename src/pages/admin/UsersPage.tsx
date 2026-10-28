import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import {
  checkCfHeaderSpoofable,
  diagnoseClientIp,
  inviteStaff,
  publicSignupEnabled,
  listProfiles,
  removeStaffAccount,
  setUserAdmin,
  type ClientIpDiagnosis,
} from '../../lib/api'
import { validateEmail } from '../../lib/validation'
import { formatDateTime } from '../../lib/datetime'
import type { Profile } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { CopyButton } from '../../components/CopyButton'
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui'

export default function UsersPage() {
  const { session } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ipCheck, setIpCheck] = useState<ClientIpDiagnosis | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteAdmin, setInviteAdmin] = useState(false)
  const [inviting, setInviting] = useState<'email' | 'link' | null>(null)
  const [inviteLink, setInviteLink] = useState<{ email: string; link: string } | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const inviteCardRef = useRef<HTMLDivElement>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteDone, setInviteDone] = useState<string | null>(null)
  const [removed, setRemoved] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
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

  async function onInvite(e: FormEvent, delivery: 'email' | 'link' = 'email') {
    e.preventDefault()
    setInviteError(null)
    setInviteDone(null)
    setInviteLink(null)
    const email = inviteEmail.trim().toLowerCase()
    const invalid = email ? validateEmail(email) : 'Enter an email address.'
    if (invalid) return setInviteError(invalid)
    setInviting(delivery)
    try {
      const res = await inviteStaff(email, inviteAdmin, delivery)
      if (res.link) setInviteLink({ email: res.email, link: res.link })
      setInviteDone(
        res.warning ??
          (res.link
            ? `Invite link for ${res.email}${res.admin ? ' (administrator)' : ''} is ready. Send it to them yourself.`
            : `Invite sent to ${res.email}${res.admin ? ' as administrator' : ''}. They choose a password from the email link.`),
      )
      setInviteEmail('')
      setInviteAdmin(false)
      load()
    } catch (err) {
      setInviteError((err as Error).message)
    } finally {
      setInviting(null)
    }
  }

  /** New one-time link for someone whose invite is still pending (replaces the earlier link). */
  async function linkFor(u: Profile) {
    if (!u.email) return
    setError(null)
    setInviteError(null)
    setInviteDone(null)
    setInviteLink(null)
    setLinking(u.id)
    try {
      const res = await inviteStaff(u.email, false, 'link')
      if (res.link) {
        setInviteLink({ email: res.email, link: res.link })
        setInviteDone(`New invite link for ${res.email} is ready. Earlier links for them stop working.`)
        inviteCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLinking(null)
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

  async function remove(u: Profile) {
    const what = u.confirmed_at ? 'Remove' : 'Cancel the invite for'
    if (
      !window.confirm(
        `${what} ${u.email}? They lose access to every event and can no longer sign in. Past check-ins stay in the records.`,
      )
    )
      return
    setError(null)
    setRemoved(null)
    setRemoving(u.id)
    try {
      await removeStaffAccount(u.id)
      setRemoved(`${u.email} was removed.`)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Staff accounts"
        description="Everyone who can sign in. Assign people to events from each event’s Staff tab. Removing an account takes away access to every event."
      />
      {signupOpen && (
        <Alert tone="bad" title="Public sign-up is switched on" className="mb-5">
          Anyone can create an account. In Supabase, open Authentication → Sign In / Providers and turn off
          “Allow new users to sign up”.
        </Alert>
      )}
      <div ref={inviteCardRef} className="scroll-mt-20">
        <Card className="mb-6 p-5">
          <h2 className="text-base font-semibold">Invite staff</h2>
          <p className="mt-1 text-sm text-ink-600">
            They receive an email, choose a password, and can then be assigned to events from each event’s
            Staff tab.
          </p>
          <form className="mt-4 space-y-4" onSubmit={(e) => onInvite(e)} noValidate>
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
            {inviteLink && (
              <div
                className="space-y-2 rounded-xl border border-ink-200 bg-ink-50 p-3"
                data-testid="invite-link"
              >
                <label htmlFor="invite-link-url" className="text-sm font-semibold">
                  Invite link for {inviteLink.email}
                </label>
                <input
                  id="invite-link-url"
                  readOnly
                  value={inviteLink.link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={inviteLink.link} label="Copy link" size="sm" />
                  {typeof navigator.share === 'function' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        navigator
                          .share({
                            title: 'PassSystem invite',
                            text: 'Your PassSystem staff invite:',
                            url: inviteLink.link,
                          })
                          .catch(() => undefined)
                      }
                    >
                      Share…
                    </Button>
                  )}
                </div>
                <p className="text-xs text-ink-500">
                  Send it by WhatsApp, SMS or any chat. It works once and expires after the “Email OTP
                  expiration” time set in Supabase (1 hour by default). Anyone with the link can claim the
                  account, so send it only to that person.
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={inviting === 'email'} disabled={inviting !== null}>
                Send invite email
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={inviting === 'link'}
                disabled={inviting !== null}
                onClick={(e) => onInvite(e, 'link')}
              >
                Create invite link
              </Button>
            </div>
          </form>
        </Card>
      </div>
      {error && (
        <Alert tone="bad" className="mb-4">
          {error}
        </Alert>
      )}
      {removed && (
        <Alert tone="ok" className="mb-4">
          {removed}
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
                  {!u.confirmed_at && u.email && (
                    <Button variant="ghost" size="sm" loading={linking === u.id} onClick={() => linkFor(u)}>
                      Invite link
                    </Button>
                  )}
                  {u.id !== session?.user.id && !u.is_admin && (
                    <Button variant="danger" size="sm" loading={removing === u.id} onClick={() => remove(u)}>
                      {u.confirmed_at ? 'Remove' : 'Cancel invite'}
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
          {spoof === 'failed' && (
            <span data-testid="spoof-failed">
              {' '}
              — the browser could not send the test header (Supabase Cloud blocks it), so this test can&apos;t
              decide it here. Rate limiting is still active.
            </span>
          )}
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
