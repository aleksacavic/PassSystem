// Regression tests for Codex review 5 (docs/CODEX_REVIEW_5.md, R5-01).
import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { anonClient, createStaff, db, env, service, uid, type StaffUser } from './helpers'

let admin: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'r5-admin' })
})

const isAdmin = async (id: string) =>
  (await db<{ is_admin: boolean }>(`select is_admin from public.profiles where id = $1`, [id]))[0]!.is_admin

async function waitingOn(pattern: string) {
  for (let i = 0; i < 100; i++) {
    const rows = await db(
      `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1`,
      [pattern],
    )
    if (rows.length) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`nothing waiting for ${pattern}`)
}

const reserve = async (email: string) =>
  (await service.rpc('begin_invite', { p_email: email })).data as number | null

describe('[R5-01] one invite at a time per address', () => {
  it('a second reservation waits until the first one saves its role, ends, or expires', async () => {
    const email = `r5-lease-${uid()}@passsystem.test`
    const first = await reserve(email)
    expect(first).toEqual(expect.any(Number))
    expect(await reserve(email)).toBeNull()

    // Saving the role releases the reservation, whatever the outcome.
    const { data } = await service.auth.admin.generateLink({ type: 'invite', email })
    expect(
      (
        await service.rpc('set_pending_admin', {
          p_user_id: data.user!.id,
          p_admin: false,
          p_generation: first,
        })
      ).data,
    ).toBe('cleared')
    const second = await reserve(email)
    expect(second).toBe(first! + 1)

    // end_invite releases only the caller's own reservation.
    await service.rpc('end_invite', { p_email: email, p_generation: first })
    expect(await reserve(email)).toBeNull()
    await service.rpc('end_invite', { p_email: email, p_generation: second })
    const third = await reserve(email)
    expect(third).toBe(second! + 1)

    // A request that died keeps its reservation only until it expires.
    await db(
      `update private.invite_generations set lease_until = now() - interval '1 second' where email = $1`,
      [email],
    )
    expect(await reserve(email)).toBe(third! + 1)
  })

  it('only the service role can reserve or release an address', async () => {
    expect((await admin.client.rpc('begin_invite', { p_email: 'x@passsystem.test' })).error?.code).toBe(
      '42501',
    )
    expect(
      (await admin.client.rpc('end_invite', { p_email: 'x@passsystem.test', p_generation: 1 })).error?.code,
    ).toBe('42501')
  })

  it('an invite sent while another is still waiting for Auth is refused, and the first link keeps working', async () => {
    const email = `r5-fn-${uid()}@passsystem.test`
    const token = (await admin.client.auth.getSession()).data.session!.access_token
    const invite = (asAdmin: boolean) =>
      fetch(`${env.apiUrl}/functions/v1/invite-staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.anonKey,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email,
          admin: asAdmin,
          redirectTo: 'http://127.0.0.1:4173/',
          delivery: 'link',
        }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
    const tokenOf = (link: unknown) =>
      new URLSearchParams(new URL(link as string).hash.slice(1)).get('token')!

    const created = await invite(false) // the pending account exists
    expect(created.body).toMatchObject({ ok: true })
    const userId = created.body.user_id as string

    // Hold the account's row: Auth's token update for invite A waits on it.
    const holder = new pg.Client({ connectionString: env.dbUrl })
    await holder.connect()
    let a: Awaited<ReturnType<typeof invite>>
    try {
      await holder.query('begin')
      await holder.query(`select 1 from auth.users where id = $1 for update`, [userId])
      const pendingA = invite(true)
      await waitingOn('%users%')
      // B arrives while A waits for Auth. It must be refused at once, not join the queue for Auth.
      const pendingB = invite(false)
      const b = await Promise.race([pendingB, new Promise((r) => setTimeout(() => r('still waiting'), 5000))])
      expect(b).toMatchObject({ status: 409, body: { ok: false, error: 'invite_in_progress' } })
      await holder.query('commit')
      await pendingB
      a = await pendingA
    } finally {
      await holder.end()
    }
    expect(a.body).toMatchObject({ ok: true, admin: true })
    expect(
      (await anonClient().auth.verifyOtp({ type: 'invite', token_hash: tokenOf(a.body.link) })).error,
    ).toBeNull()
    expect(await isAdmin(userId)).toBe(true)
  })
})
