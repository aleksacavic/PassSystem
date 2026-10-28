import { beforeAll, describe, expect, it } from 'vitest'
import {
  anonClient,
  createEvent,
  createStaff,
  db,
  env,
  register,
  type StaffUser,
  type TestEvent,
} from './helpers'

let admin: StaffUser
let organizer: StaffUser
let operator: StaffUser
let stranger: StaffUser
let ev: TestEvent
let other: TestEvent
let regId: string
let token: string

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'sec-admin' })
  organizer = await createStaff({ label: 'sec-org' })
  operator = await createStaff({ label: 'sec-op' })
  stranger = await createStaff({ label: 'sec-stranger' })
  ev = await createEvent(admin.client)
  other = await createEvent(admin.client)
  await admin.client.rpc('add_event_staff', {
    p_event_id: ev.id,
    p_email: organizer.email,
    p_role: 'organizer',
  })
  await admin.client.rpc('add_event_staff', {
    p_event_id: ev.id,
    p_email: operator.email,
    p_role: 'operator',
  })
  const r = await register(ev.slug, 'Secret', 'Person', 'secret@example.org')
  token = r.token
  regId = (
    await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [token],
    )
  )[0]!.id
})

describe('anonymous users', () => {
  it('cannot read any table', async () => {
    const anon = anonClient()
    for (const table of ['registrations', 'events', 'admission_logs', 'event_staff', 'profiles']) {
      const { data, error } = await anon.from(table).select('id').limit(1)
      expect(error?.code, table).toBe('42501')
      expect(data).toBeNull()
    }
  })

  it('cannot write any table', async () => {
    const anon = anonClient()
    expect(
      (await anon.from('registrations').update({ status: 'checked_in' }).eq('id', regId)).error?.code,
    ).toBe('42501')
    expect(
      (await anon.from('events').insert({ name: 'x', slug: 'x', starts_at: new Date().toISOString() })).error
        ?.code,
    ).toBe('42501')
    expect(
      (await anon.from('admission_logs').insert({ event_id: ev.id, result: 'admitted' })).error?.code,
    ).toBe('42501')
    expect((await db(`select status from registrations where id = $1`, [regId]))[0]!.status).toBe(
      'registered',
    )
  })

  it('cannot call privileged functions', async () => {
    const anon = anonClient()
    const calls: [string, Record<string, unknown>][] = [
      ['admit_pass', { p_event_id: ev.id, p_token: token }],
      ['revoke_registration', { p_registration_id: regId }],
      ['restore_registration', { p_registration_id: regId }],
      ['reissue_pass', { p_registration_id: regId }],
      ['get_event_summaries', {}],
      ['list_event_staff', { p_event_id: ev.id }],
      ['add_event_staff', { p_event_id: ev.id, p_email: 'x@y.z', p_role: 'organizer' }],
      ['remove_event_staff', { p_staff_id: regId }],
      ['set_user_admin', { p_user_id: stranger.id, p_is_admin: true }],
      ['diagnose_client_ip', {}],
    ]
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args)
      expect(error?.code, fn).toBe('42501')
    }
  })

  it('cannot reach the private schema', async () => {
    const anon = anonClient()
    const { error } = await anon.schema('private').rpc('generate_pass_token')
    expect(error).not.toBeNull()
    const { error: e2 } = await anon.rpc('generate_pass_token')
    expect(e2).not.toBeNull()
  })

  it('cannot sign up (public registration of staff accounts is disabled)', async () => {
    const { data, error } = await anonClient().auth.signUp({
      email: `intruder-${Date.now()}@passsystem.test`,
      password: 'Intruder12345',
    })
    expect(error).not.toBeNull()
    expect(data.user).toBeNull()
  })
})

describe('authenticated staff', () => {
  it('unassigned staff see no events, registrations or logs', async () => {
    const c = stranger.client
    expect((await c.from('events').select('id')).data).toEqual([])
    expect((await c.from('registrations').select('id,first_name')).data).toEqual([])
    expect((await c.from('admission_logs').select('id')).data).toEqual([])
    expect((await c.rpc('get_event_summaries')).data).toEqual([])
    expect((await c.rpc('list_event_staff', { p_event_id: ev.id })).error?.code).toBe('42501')
    const profiles = (await c.from('profiles').select('id')).data!
    expect(profiles.map((p) => p.id)).toEqual([stranger.id])
  })

  it('nobody can read credential hashes through the API', async () => {
    for (const c of [admin.client, organizer.client]) {
      const { error } = await c.from('registrations').select('pass_token_hash').limit(1)
      expect(error?.code).toBe('42501')
      const { error: e2 } = await c.from('registrations').select('request_id_hash').limit(1)
      expect(e2?.code).toBe('42501')
    }
  })

  it('operators can scan but not read attendee lists or administer the event', async () => {
    const c = operator.client
    expect((await c.from('registrations').select('id,first_name').eq('event_id', ev.id)).data).toEqual([])
    expect((await c.from('admission_logs').select('id').eq('event_id', ev.id)).data).toEqual([])
    const upd = await c.from('events').update({ name: 'Hacked' }).eq('id', ev.id).select('id')
    expect(upd.data ?? []).toEqual([])
    expect((await db(`select name from events where id = $1`, [ev.id]))[0]!.name).not.toBe('Hacked')
    expect((await c.rpc('revoke_registration', { p_registration_id: regId })).error?.code).toBe('42501')
    expect((await c.rpc('reissue_pass', { p_registration_id: regId })).error?.code).toBe('42501')
    expect((await c.rpc('list_event_staff', { p_event_id: ev.id })).error?.code).toBe('42501')
    expect(
      (await c.rpc('add_event_staff', { p_event_id: ev.id, p_email: stranger.email, p_role: 'operator' }))
        .error?.code,
    ).toBe('42501')
    // sees the event itself (for the scanner header)
    expect((await c.rpc('get_event_summaries', { p_event_id: ev.id })).data[0]).toMatchObject({
      my_role: 'operator',
    })
  })

  it('organizers manage only their own events', async () => {
    const c = organizer.client
    expect((await c.from('registrations').select('id').eq('event_id', ev.id)).data).toHaveLength(1)
    expect((await c.from('registrations').select('id').eq('event_id', other.id)).data).toEqual([])
    const upd = await c.from('events').update({ name: 'Renamed by org' }).eq('id', other.id).select('id')
    expect(upd.data ?? []).toEqual([])
    const otherReg = await register(other.slug)
    const otherId = (
      await db<{ id: string }>(
        `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
        [otherReg.token],
      )
    )[0]!.id
    expect((await c.rpc('revoke_registration', { p_registration_id: otherId })).error?.code).toBe('42501')
    expect((await c.rpc('admit_pass', { p_event_id: other.id, p_token: otherReg.token })).error?.code).toBe(
      '42501',
    )
  })

  it('organizers can add operators but not organizers; cannot remove organizers', async () => {
    const c = organizer.client
    expect(
      (await c.rpc('add_event_staff', { p_event_id: ev.id, p_email: stranger.email, p_role: 'organizer' }))
        .error?.hint,
    ).toBe('admin_required')
    expect(
      (await c.rpc('add_event_staff', { p_event_id: ev.id, p_email: stranger.email, p_role: 'operator' }))
        .error,
    ).toBeNull()
    const staff = (await c.rpc('list_event_staff', { p_event_id: ev.id })).data as {
      id: string
      role: string
      user_id: string
    }[]
    const orgRow = staff.find((s) => s.user_id === organizer.id)!
    expect((await c.rpc('remove_event_staff', { p_staff_id: orgRow.id })).error?.hint).toBe('admin_required')
    const strangerRow = staff.find((s) => s.user_id === stranger.id)!
    expect((await c.rpc('remove_event_staff', { p_staff_id: strangerRow.id })).error).toBeNull()
  })

  it('organizers cannot downgrade another organizer by re-adding them', async () => {
    const co = await createStaff({ label: 'sec-coorg' })
    expect(
      (
        await admin.client.rpc('add_event_staff', {
          p_event_id: ev.id,
          p_email: co.email,
          p_role: 'organizer',
        })
      ).error,
    ).toBeNull()
    const res = await organizer.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: co.email,
      p_role: 'operator',
    })
    expect(res.error?.hint).toBe('admin_required')
    const rows = await db(`select role from event_staff where event_id = $1 and user_id = $2`, [ev.id, co.id])
    expect(rows[0]!.role).toBe('organizer')
  })

  it('only administrators create or delete events', async () => {
    const ins = await organizer.client
      .from('events')
      .insert({ name: 'Org event', slug: `org-${Date.now()}`, starts_at: new Date().toISOString() })
    expect(ins.error?.code).toBe('42501')
    const del = await organizer.client.from('events').delete().eq('id', ev.id).select('id')
    expect(del.data ?? []).toEqual([])
  })

  it('cannot forge created_by or other protected columns', async () => {
    const ins = await admin.client.from('events').insert({
      name: 'Forge',
      slug: `forge-${Date.now()}`,
      starts_at: new Date().toISOString(),
      created_by: stranger.id,
    })
    expect(ins.error?.code).toBe('42501')
    const upd = await admin.client.from('events').update({ created_at: '2000-01-01' }).eq('id', ev.id)
    expect(upd.error?.code).toBe('42501')
  })

  it('events with registrations cannot be deleted (history preserved)', async () => {
    const del = await admin.client.from('events').delete().eq('id', ev.id)
    expect(del.error?.code).toBe('23503')
  })

  it('only administrators grant administrator rights', async () => {
    expect(
      (await organizer.client.rpc('set_user_admin', { p_user_id: organizer.id, p_is_admin: true })).error
        ?.code,
    ).toBe('42501')
    expect((await db(`select is_admin from profiles where id = $1`, [organizer.id]))[0]!.is_admin).toBe(false)
    expect(
      (await admin.client.rpc('set_user_admin', { p_user_id: admin.id, p_is_admin: false })).error?.hint,
    ).toBe('self_demotion')
    // profiles.is_admin cannot be changed directly
    const upd = await organizer.client.from('profiles').update({ is_admin: true }).eq('id', organizer.id)
    expect(upd.error?.code).toBe('42501')
  })
})

describe('credential strength', () => {
  it('tokens are uniformly random over the Crockford alphabet (no collisions in 5000)', async () => {
    const rows = await db<{ t: string }>(
      `select private.generate_pass_token() as t from generate_series(1, 5000)`,
    )
    const tokens = rows.map((r) => r.t)
    expect(new Set(tokens).size).toBe(5000)
    const counts = new Map<string, number>()
    for (const t of tokens) {
      expect(t).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/)
      for (const ch of t) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    expect(counts.size).toBe(32)
    const expected = (5000 * 24) / 32
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.1)
  })
})

describe('rate limiting', () => {
  it('limits registrations per client IP and cannot be bypassed with spoofed headers', async () => {
    const ev2 = await createEvent(admin.client)
    await db(`delete from private.rate_limit_buckets`)
    await db(`update private.settings set value = 5 where key = 'register_per_ip_per_minute'`)
    try {
      const results = []
      for (let i = 0; i < 8; i++) {
        const client = anonClient({ 'X-Forwarded-For': `10.0.0.${i}`, 'cf-connecting-ip': `10.1.0.${i}` })
        const { data } = await client.rpc('register_for_event', {
          p_slug: ev2.slug,
          p_first_name: 'Rate',
          p_last_name: `L${i}`,
          p_accept_terms: true,
        })
        results.push(data)
      }
      expect(results.filter((r) => r.ok)).toHaveLength(5)
      expect(results.filter((r) => r.error === 'rate_limited')).toHaveLength(3)
      // Counters store a salted hash, never the IP.
      const buckets = await db<{ bucket: string }>(`select bucket from private.rate_limit_buckets`)
      expect(buckets.some((b) => /\d+\.\d+\.\d+\.\d+/.test(b.bucket))).toBe(false)
    } finally {
      await db(`update private.settings set value = 100000 where key = 'register_per_ip_per_minute'`)
      await db(`delete from private.rate_limit_buckets`)
    }
  })

  it('limits pass lookups (token guessing)', async () => {
    await db(`delete from private.rate_limit_buckets`)
    await db(`update private.settings set value = 10 where key = 'pass_lookup_per_ip_per_minute'`)
    try {
      const anon = anonClient()
      const out = []
      for (let i = 0; i < 13; i++)
        out.push((await anon.rpc('get_pass', { p_token: 'ZZZZZZZZZZZZZZZZZZZZZZZZ' })).data.error)
      expect(out.filter((e) => e === 'rate_limited')).toHaveLength(3)
    } finally {
      await db(`update private.settings set value = 100000 where key = 'pass_lookup_per_ip_per_minute'`)
      await db(`delete from private.rate_limit_buckets`)
    }
  })

  it('admin diagnostic reports the IP source used', async () => {
    const { data, error } = await admin.client.rpc('diagnose_client_ip')
    expect(error).toBeNull()
    expect(data.source).toBe('x-real-ip')
  })
})

describe('schema hardening', () => {
  it('every public table has RLS enabled', async () => {
    const rows = await db<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(5)
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true)
  })

  it('every SECURITY DEFINER function pins search_path', async () => {
    const rows = await db<{ proname: string; cfg: string[] | null }>(
      `select p.proname, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','private') and p.prosecdef`,
    )
    for (const r of rows)
      expect(
        r.cfg?.some((c) => c.startsWith('search_path=')),
        r.proname,
      ).toBe(true)
  })

  it('anon can execute only the three public attendee functions', async () => {
    const rows = await db<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    )
    expect(rows.map((r) => r.proname)).toEqual(['get_pass', 'get_public_event', 'register_for_event'])
  })

  it('the API URL used by tests is local', () => expect(env.apiUrl).toMatch(/127\.0\.0\.1|localhost/))
})
