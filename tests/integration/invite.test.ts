import { beforeAll, describe, expect, it } from 'vitest'
import { anonClient, createStaff, db, env, uid, type StaffUser } from './helpers'

let admin: StaffUser
let staff: StaffUser

async function invite(token: string | null, body: unknown) {
  const res = await fetch(`${env.apiUrl}/functions/v1/invite-staff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

const tokenOf = async (u: StaffUser) => (await u.client.auth.getSession()).data.session!.access_token

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'inv-admin' })
  staff = await createStaff({ label: 'inv-staff' })
})

describe('invite-staff Edge Function', () => {
  it('rejects anonymous callers', async () => {
    const res = await invite(null, { email: `x-${uid()}@passsystem.test` })
    expect(res.status).toBe(401)
    // anon key as bearer is not a user session
    const res2 = await invite(env.anonKey.startsWith('eyJ') ? env.anonKey : null, {
      email: `x-${uid()}@passsystem.test`,
    })
    expect(res2.status).toBe(401)
  })

  it('rejects signed-in staff who are not administrators', async () => {
    const email = `inv-denied-${uid()}@passsystem.test`
    const res = await invite(await tokenOf(staff), { email })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('admin_required')
    expect(await db(`select 1 from auth.users where email = $1`, [email])).toHaveLength(0)
  })

  it('invites a staff member: unconfirmed account + profile, no admin rights', async () => {
    const email = `inv-new-${uid()}@passsystem.test`
    const res = await invite(await tokenOf(admin), { email: `  ${email.toUpperCase()} ` })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, email, admin: false })
    const [user] = await db<{ id: string; confirmed: boolean; invited: boolean }>(
      `select id, email_confirmed_at is not null as confirmed, invited_at is not null as invited from auth.users where email = $1`,
      [email],
    )
    expect(user).toMatchObject({ confirmed: false, invited: true })
    const [profile] = await db(`select is_admin from public.profiles where id = $1`, [user!.id])
    expect(profile).toEqual({ is_admin: false })
  })

  it('an administrator invite takes effect only when the invite is accepted', async () => {
    const email = `inv-admin2-${uid()}@passsystem.test`
    const res = await invite(await tokenOf(admin), { email, admin: true })
    expect(res.status).toBe(200)
    expect(res.body?.admin).toBe(true)
    const adminFlag = async () =>
      (
        await db<{ is_admin: boolean }>(
          `select p.is_admin from public.profiles p join auth.users u on u.id = p.id where u.email = $1`,
          [email],
        )
      )[0]!.is_admin
    expect(await adminFlag()).toBe(false) // a mistyped address never becomes admin
    await db(`update auth.users set email_confirmed_at = now() where email = $1`, [email]) // invite accepted
    expect(await adminFlag()).toBe(true)
  })

  it('an invited person cannot be assigned to events until they accept', async () => {
    const email = `inv-assign-${uid()}@passsystem.test`
    await invite(await tokenOf(admin), { email })
    const ev = (
      await admin.client
        .from('events')
        .insert({
          name: 'Invite assign',
          slug: `inv-${uid()}`,
          starts_at: new Date(Date.now() + 864e5).toISOString(),
        })
        .select('id')
        .single()
    ).data!
    const res = await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: email,
      p_role: 'operator',
    })
    expect(res.error?.hint).toBe('user_not_confirmed')
  })

  it('reports existing accounts and invalid emails', async () => {
    const dup = await invite(await tokenOf(admin), { email: staff.email })
    expect(dup.status).toBe(409)
    expect(dup.body?.error).toBe('user_exists')
    for (const email of ['', 'not-an-email', 'a@b', 'x'.repeat(250) + '@example.org']) {
      const res = await invite(await tokenOf(admin), { email })
      expect(res.status, email).toBe(400)
    }
  })

  it('does not let invited users escalate: invitee has no event access', async () => {
    const email = `inv-check-${uid()}@passsystem.test`
    await invite(await tokenOf(admin), { email })
    const rows = await db(
      `select count(*)::int as n from public.event_staff s join auth.users u on u.id = s.user_id where u.email = $1`,
      [email],
    )
    expect(rows[0]!.n).toBe(0)
    // public sign-up remains closed
    const { error } = await anonClient().auth.signUp({
      email: `inv-signup-${uid()}@passsystem.test`,
      password: 'Signup12345',
    })
    expect(error).not.toBeNull()
  })

  it('creates a shareable invite link without sending email', async () => {
    const email = `inv-link-${uid()}@passsystem.test`
    const site = 'http://127.0.0.1:4173/'
    const res = await invite(await tokenOf(admin), { email, delivery: 'link', redirectTo: site })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, email, admin: false })
    const link = new URL(String(res.body?.link))
    expect(`${link.origin}${link.pathname}`).toBe('http://127.0.0.1:4173/invite')
    const token = new URLSearchParams(link.hash.slice(1)).get('token')!
    expect(token).toMatch(/^[A-Za-z0-9_-]{10,200}$/)

    // No email was sent.
    const mail = await (
      await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()
    expect(mail.messages_count ?? 0).toBe(0)

    // A new link for the same pending invite replaces the old one.
    const again = await invite(await tokenOf(admin), { email, delivery: 'link', redirectTo: site })
    expect(again.status).toBe(200)
    expect(again.body?.user_id).toBe(res.body?.user_id)
    const token2 = new URLSearchParams(new URL(String(again.body?.link)).hash.slice(1)).get('token')!
    expect(token2).not.toBe(token)

    // The link signs the invited person in exactly once.
    const guest = anonClient()
    const first = await guest.auth.verifyOtp({ type: 'invite', token_hash: token2 })
    expect(first.error).toBeNull()
    expect(first.data.session?.user.email).toBe(email)
    const reuse = await anonClient().auth.verifyOtp({ type: 'invite', token_hash: token2 })
    expect(reuse.error).not.toBeNull()

    // Once accepted, the account exists: no more invite links.
    const dup = await invite(await tokenOf(admin), { email, delivery: 'link', redirectTo: site })
    expect(dup.status).toBe(409)
  })

  it('invite links: administrators only, and a site address is required', async () => {
    const email = `inv-link2-${uid()}@passsystem.test`
    const denied = await invite(await tokenOf(staff), {
      email,
      delivery: 'link',
      redirectTo: 'https://x.test/',
    })
    expect(denied.status).toBe(403)
    const noSite = await invite(await tokenOf(admin), { email, delivery: 'link' })
    expect(noSite.status).toBe(400)
    expect(await db(`select 1 from auth.users where email = $1`, [email])).toHaveLength(0)
  })
})
