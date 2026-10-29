/**
 * Regression tests for the independent audit findings (docs/AUDIT_REMEDIATION.md).
 * Each test failed before migration 20261028000004 and passes after it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import {
  admit,
  anonClient,
  createEvent,
  createStaff,
  db,
  env,
  register,
  service,
  type StaffUser,
  termsVersion,
  setInviteRole,
} from './helpers'

let admin: StaffUser
let operator: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'aud-admin' })
  operator = await createStaff({ label: 'aud-op' })
})

const regId = async (token: string) =>
  (
    await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [token],
    )
  )[0]!.id

async function asUser(userId: string) {
  const c = new pg.Client({ connectionString: env.dbUrl })
  await c.connect()
  await c.query('begin')
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await c.query('set local role authenticated')
  return c
}

describe('[F-01] scan retries after a client timeout', () => {
  it('a retry with the same attempt id returns the committed admission, not "already used"', async () => {
    const ev = await createEvent(admin.client)
    await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: operator.email,
      p_role: 'operator',
    })
    const r = await register(ev.slug, 'Slow', 'Network')
    const attempt = randomUUID()

    // Hold the row lock so the first request outlives the client's timeout.
    const blocker = new pg.Client({ connectionString: env.dbUrl })
    await blocker.connect()
    await blocker.query('begin')
    await blocker.query(`select id from registrations where id = $1 for update`, [await regId(r.token)])
    const released = new Promise<void>((res) =>
      setTimeout(
        () =>
          void blocker
            .query('commit')
            .then(() => blocker.end())
            .then(res),
        1500,
      ),
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const first = await operator.client
      .rpc('admit_pass', { p_event_id: ev.id, p_token: r.token, p_attempt_id: attempt })
      .abortSignal(controller.signal)
    expect(first.error).not.toBeNull() // the operator saw amber
    await released
    await new Promise((res) => setTimeout(res, 500)) // let the server-side call commit

    const retry = await operator.client.rpc('admit_pass', {
      p_event_id: ev.id,
      p_token: r.token,
      p_attempt_id: attempt,
    })
    expect(retry.data).toMatchObject({ result: 'admitted', replayed: true, attendee: { first_name: 'Slow' } })

    // A new scan (new attempt) of the same pass is still rejected.
    const again = await operator.client.rpc('admit_pass', {
      p_event_id: ev.id,
      p_token: r.token,
      p_attempt_id: randomUUID(),
    })
    expect(again.data.result).toBe('already_used')
    const logs = await db(`select result from admission_logs where event_id = $1 order by attempted_at`, [
      ev.id,
    ])
    expect(logs.map((l) => l.result)).toEqual(['admitted', 'already_used'])
  })

  it('attempt ids are per operator and per event', async () => {
    const ev = await createEvent(admin.client)
    const other = await createEvent(admin.client)
    const r = await register(ev.slug)
    const attempt = randomUUID()
    expect(
      (await admin.client.rpc('admit_pass', { p_event_id: ev.id, p_token: r.token, p_attempt_id: attempt }))
        .data.result,
    ).toBe('admitted')
    // Same attempt id from another operator is not a replay.
    await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: operator.email,
      p_role: 'operator',
    })
    expect(
      (
        await operator.client.rpc('admit_pass', {
          p_event_id: ev.id,
          p_token: r.token,
          p_attempt_id: attempt,
        })
      ).data.result,
    ).toBe('already_used')
    // Reusing the attempt id for another event is refused outright (R2-02).
    expect(
      (
        await admin.client.rpc('admit_pass', {
          p_event_id: other.id,
          p_token: r.token,
          p_attempt_id: attempt,
        })
      ).error?.hint,
    ).toBe('attempt_conflict')
  })
})

describe('[F-02] rate-limit IP source', () => {
  it('ships with cf-connecting-ip untrusted, so forged headers do not bypass limits', async () => {
    expect(
      (await db(`select value from private.settings where key = 'trust_cf_connecting_ip'`))[0]!.value,
    ).toBe(0)
    const ev = await createEvent(admin.client)
    await db(`delete from private.rate_limit_buckets`)
    await db(`update private.settings set value = 5 where key = 'register_per_ip_per_minute'`)
    try {
      let ok = 0
      for (let i = 0; i < 8; i++) {
        const { data } = await anonClient({ 'cf-connecting-ip': `203.0.113.${i}` }).rpc(
          'register_for_event',
          {
            p_slug: ev.slug,
            p_first_name: 'Rate',
            p_last_name: `L${i}`,
            p_accept_terms: true,
            p_terms_version: await termsVersion(ev.slug),
          },
        )
        if (data.ok) ok++
      }
      expect(ok).toBe(5)
    } finally {
      await db(`update private.settings set value = 100000 where key = 'register_per_ip_per_minute'`)
      await db(`delete from private.rate_limit_buckets`)
    }
  })

  it('the admin diagnostic exposes the forged value so deployments can be checked', async () => {
    const res = await admin.client.rpc('diagnose_client_ip').setHeader('cf-connecting-ip', '203.0.113.77')
    expect(res.data).toMatchObject({
      cf_connecting_ip: '203.0.113.77',
      trust_cf_connecting_ip: false,
      source: 'x-real-ip',
    })
  })
})

describe('[F-03] IPv6 clients are grouped by /64', () => {
  it('addresses in one /64 share a fingerprint; other /64s and IPv4 do not', async () => {
    const fp = async (ip: string) => {
      const c = new pg.Client({ connectionString: env.dbUrl })
      await c.connect()
      try {
        await c.query('begin')
        await c.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-real-ip': ip })])
        return (await c.query(`select private.client_fingerprint() as f`)).rows[0].f as string
      } finally {
        await c.end()
      }
    }
    const a = await fp('2001:db8:1:2::1')
    expect(await fp('2001:db8:1:2:ffff:abcd:1234:5678')).toBe(a)
    expect(await fp('2001:db8:1:3::1')).not.toBe(a)
    expect(await fp('198.51.100.1')).not.toBe(await fp('198.51.100.2'))
  })
})

describe('[F-04] registration replay is bound to the submitted details', () => {
  it('the same request id with different names registers the new person', async () => {
    const ev = await createEvent(admin.client)
    const rid = randomUUID()
    const first = await register(ev.slug, 'Alice', 'First', null, rid)
    const second = await register(ev.slug, 'Bob', 'Second', null, rid)
    expect(second).toMatchObject({ ok: true, replayed: false, registration: { first_name: 'Bob' } })
    expect((await anonClient().rpc('get_pass', { p_token: first.token })).data.ok).toBe(true)
    // An identical replay still returns the same registration (double tap / retry).
    const replay = await register(ev.slug, 'Bob', 'Second', null, rid)
    expect(replay).toMatchObject({ ok: true, replayed: true, registration: { first_name: 'Bob' } })
    expect(
      (await db(`select count(*)::int as n from registrations where event_id = $1`, [ev.id]))[0]!.n,
    ).toBe(2)
  })
})

describe('[F-05] restore respects capacity', () => {
  it('cannot push an event over max_attendees', async () => {
    const ev = await createEvent(admin.client, { max_attendees: 2 })
    const one = await register(ev.slug, 'Cap', 'One')
    await register(ev.slug, 'Cap', 'Two')
    const id = await regId(one.token)
    await admin.client.rpc('revoke_registration', { p_registration_id: id })
    expect((await register(ev.slug, 'Cap', 'Three')).ok).toBe(true)
    const res = await admin.client.rpc('restore_registration', { p_registration_id: id })
    expect(res.error?.hint).toBe('event_full')
    const [{ n }] = await db<{ n: number }>(
      `select count(*)::int n from registrations where event_id=$1 and status<>'revoked'`,
      [ev.id],
    )
    expect(n).toBe(2)
  })
})

describe('[F-06] scans and registrations for one event do not block each other', () => {
  it('a registration completes while an admission transaction is still open', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug, 'Open', 'Scan')
    const c = await asUser(admin.id)
    try {
      await c.query(`select public.admit_pass($1, $2)`, [ev.id, r.token]) // uncommitted
      const started = Date.now()
      const res = await register(ev.slug, 'Meanwhile', 'Registered')
      expect(res.ok).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await c.query('rollback')
      await c.end()
    }
  })
})

describe('[F-07] wrong-event scans do not leak the other event', () => {
  it("the scanning event's organizers see neither the registration nor the other event id", async () => {
    const orgB = await createStaff({ label: 'aud-orgB' })
    const evA = await createEvent(admin.client)
    const evB = await createEvent(admin.client)
    await admin.client.rpc('add_event_staff', {
      p_event_id: evB.id,
      p_email: orgB.email,
      p_role: 'organizer',
    })
    const r = await register(evA.slug)
    expect((await admit(orgB.client, evB.id, r.token)).data.result).toBe('wrong_event')
    const { data } = await orgB.client
      .from('admission_logs')
      .select('registration_id,details')
      .eq('event_id', evB.id)
    expect(data).toHaveLength(1)
    expect(JSON.stringify(data)).not.toContain(evA.id)
    expect(data![0]!.registration_id).toBeNull()
  })

  it('staff of both events still get the full picture', async () => {
    const evA = await createEvent(admin.client)
    const evB = await createEvent(admin.client)
    const r = await register(evA.slug, 'Both', 'Events')
    const res = await admit(admin.client, evB.id, r.token)
    expect(res.data).toMatchObject({ result: 'wrong_event', attendee: { first_name: 'Both' } })
    const [log] = await db(`select registration_id, details from admission_logs where event_id = $1`, [
      evB.id,
    ])
    expect(log!.registration_id).toBe(await regId(r.token))
  })
})

describe('[F-08] only confirmed accounts become staff', () => {
  it('organizers cannot assign, and admins cannot promote, unconfirmed accounts', async () => {
    const email = `aud-unconfirmed-${randomUUID().slice(0, 8)}@passsystem.test`
    const { data } = await service.auth.admin.createUser({
      email,
      password: `Pw-${randomUUID()}1a`,
      email_confirm: false,
    })
    const ev = await createEvent(admin.client)
    const assign = await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: email,
      p_role: 'operator',
    })
    expect(assign.error?.hint).toBe('user_not_confirmed')
    const promote = await admin.client.rpc('set_user_admin', { p_user_id: data.user!.id, p_is_admin: true })
    expect(promote.error?.hint).toBe('user_not_confirmed')
    // After confirmation both work.
    await db(`update auth.users set email_confirmed_at = now() where id = $1`, [data.user!.id])
    expect(
      (await db(`select confirmed_at is not null as c from profiles where id = $1`, [data.user!.id]))[0]!.c,
    ).toBe(true)
    expect(
      (await admin.client.rpc('add_event_staff', { p_event_id: ev.id, p_email: email, p_role: 'operator' }))
        .error,
    ).toBeNull()
  })

  it('a pending administrator invite is granted only when the invite is accepted', async () => {
    const email = `aud-pending-${randomUUID().slice(0, 8)}@passsystem.test`
    const { data } = await service.auth.admin.createUser({ email, email_confirm: false })
    expect((await setInviteRole(data.user!.id, true)).error).toBeNull()
    expect((await db(`select is_admin from profiles where id = $1`, [data.user!.id]))[0]!.is_admin).toBe(
      false,
    )
    await db(`update auth.users set email_confirmed_at = now() where id = $1`, [data.user!.id])
    expect((await db(`select is_admin from profiles where id = $1`, [data.user!.id]))[0]!.is_admin).toBe(true)
  })

  it('users cannot grant themselves a pending admin flag (user_metadata is not app_metadata)', async () => {
    const u = await createStaff({ label: 'aud-selfflag' })
    await u.client.auth.updateUser({ data: { pending_admin: true } })
    await db(`update auth.users set email_confirmed_at = now() where id = $1`, [u.id])
    expect((await db(`select is_admin from profiles where id = $1`, [u.id]))[0]!.is_admin).toBe(false)
  })
})

describe('[F-09] administrators cannot all be removed', () => {
  it('two admins demoting each other concurrently leaves one admin', async () => {
    const A = await createStaff({ admin: true, label: 'aud-adminA' })
    const B = await createStaff({ admin: true, label: 'aud-adminB' })
    // Only A and B are admins for this test.
    const others = await db<{ id: string }>(`select id from profiles where is_admin and id not in ($1, $2)`, [
      A.id,
      B.id,
    ])
    await db(`update profiles set is_admin = false where id = any($1)`, [others.map((o) => o.id)])
    try {
      const tA = await asUser(A.id)
      const tB = await asUser(B.id)
      await tA.query('select public.set_user_admin($1, false)', [B.id])
      const bResult = tB.query('select public.set_user_admin($1, false)', [A.id]).then(
        () => 'ok',
        (e: { message: string }) => e.message,
      )
      await new Promise((res) => setTimeout(res, 200))
      await tA.query('commit')
      const outcome = await bResult
      await tB.query(outcome === 'ok' ? 'commit' : 'rollback')
      await Promise.all([tA.end(), tB.end()])
      expect(outcome).toMatch(/Not authorized|At least one administrator/)
      const rows = await db<{ is_admin: boolean }>(`select is_admin from profiles where id in ($1,$2)`, [
        A.id,
        B.id,
      ])
      expect(rows.filter((r) => r.is_admin)).toHaveLength(1)
    } finally {
      await db(`update profiles set is_admin = true where id = any($1)`, [others.map((o) => o.id)])
    }
  })

  it('the last administrator cannot be demoted', async () => {
    const A = await createStaff({ admin: true, label: 'aud-last' })
    const B = await createStaff({ admin: true, label: 'aud-last2' })
    const others = await db<{ id: string }>(`select id from profiles where is_admin and id <> $1`, [A.id])
    await db(`update profiles set is_admin = false where id = any($1)`, [
      others.map((o) => o.id).filter((i) => i !== B.id),
    ])
    try {
      expect((await A.client.rpc('set_user_admin', { p_user_id: B.id, p_is_admin: false })).error).toBeNull()
      // A is now the only admin; nobody else can demote A, and A cannot demote themself.
      expect((await A.client.rpc('set_user_admin', { p_user_id: A.id, p_is_admin: false })).error?.hint).toBe(
        'self_demotion',
      )
    } finally {
      await db(`update profiles set is_admin = true where id = any($1)`, [others.map((o) => o.id)])
    }
  })
})

describe('[F-10] names', () => {
  it('rejects invisible and text-reversing characters', async () => {
    const ev = await createEvent(admin.client)
    for (const name of ['​', '‮gnp.exe', '⁦x⁩', '­', '-', "''"]) {
      expect((await register(ev.slug, name, 'X')).ok, JSON.stringify(name)).toBe(false)
    }
  })

  it('accepts real names in many scripts, normalized to NFC', async () => {
    const ev = await createEvent(admin.client)
    for (const name of ['Đorđević', "D'Arcy", 'Jean-Luc', 'Ægir', 'Иван', '李', 'O’Brien']) {
      expect((await register(ev.slug, name, 'Test')).ok, name).toBe(true)
    }
    const r = await register(ev.slug, 'Café', 'Test')
    expect(r.registration.first_name).toBe('Café')
  })
})

describe('capacity under concurrency (advisory lock)', () => {
  it('30 concurrent registrations against capacity 5 admit exactly 5', async () => {
    const ev = await createEvent(admin.client, { max_attendees: 5 })
    const res = await Promise.all(Array.from({ length: 30 }, (_, i) => register(ev.slug, 'Cap', `R${i}`)))
    expect(res.filter((r) => r.ok)).toHaveLength(5)
    expect(res.filter((r) => r.error === 'event_full')).toHaveLength(25)
  })
})
