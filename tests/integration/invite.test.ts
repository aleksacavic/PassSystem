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

  it('can invite an administrator', async () => {
    const email = `inv-admin2-${uid()}@passsystem.test`
    const res = await invite(await tokenOf(admin), { email, admin: true })
    expect(res.status).toBe(200)
    expect(res.body?.admin).toBe(true)
    const [profile] = await db(
      `select p.is_admin from public.profiles p join auth.users u on u.id = p.id where u.email = $1`,
      [email],
    )
    expect(profile).toEqual({ is_admin: true })
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
})
