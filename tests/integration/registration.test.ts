import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { anonClient, createEvent, createStaff, db, register, type StaffUser } from './helpers'

let admin: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'reg-admin' })
})

describe('public event page', () => {
  it('shows published events with safe fields only', async () => {
    const ev = await createEvent(admin.client, { location: 'Hall A', max_attendees: 10 })
    const { data } = await anonClient().rpc('get_public_event', { p_slug: ev.slug })
    expect(data.ok).toBe(true)
    expect(data.registration_state).toBe('open')
    expect(Object.keys(data.event).sort()).toEqual(
      [
        'description',
        'ends_at',
        'location',
        'name',
        'registration_closes_at',
        'registration_opens_at',
        'slug',
        'starts_at',
        'status',
        'timezone',
      ].sort(),
    )
    expect(JSON.stringify(data)).not.toMatch(/created_by|max_attendees|"id"/)
  })

  it('hides draft and archived events from the public', async () => {
    const draft = await createEvent(admin.client, { status: 'draft' })
    const archived = await createEvent(admin.client, { status: 'archived' })
    for (const ev of [draft, archived]) {
      const { data } = await anonClient().rpc('get_public_event', { p_slug: ev.slug })
      expect(data).toEqual({ ok: false, error: 'event_not_found' })
    }
    // staff can preview drafts
    const { data } = await admin.client.rpc('get_public_event', { p_slug: draft.slug })
    expect(data.registration_state).toBe('draft')
  })

  it('reports registration windows', async () => {
    const future = await createEvent(admin.client, {
      registration_opens_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    const past = await createEvent(admin.client, {
      registration_closes_at: new Date(Date.now() - 60_000).toISOString(),
    })
    const closed = await createEvent(admin.client, { status: 'closed' })
    expect(
      (await anonClient().rpc('get_public_event', { p_slug: future.slug })).data.registration_state,
    ).toBe('not_open')
    expect((await anonClient().rpc('get_public_event', { p_slug: past.slug })).data.registration_state).toBe(
      'closed',
    )
    expect(
      (await anonClient().rpc('get_public_event', { p_slug: closed.slug })).data.registration_state,
    ).toBe('closed')
  })
})

describe('register_for_event', () => {
  it('registers without email and issues a 120-bit token', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug, 'Ana', 'Petrović')
    expect(r.ok).toBe(true)
    expect(r.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/)
    expect(r.registration).toMatchObject({ first_name: 'Ana', last_name: 'Petrović', status: 'registered' })
    const rows = await db<{ email: string | null; hash_len: number }>(
      `select email, octet_length(pass_token_hash) as hash_len from registrations r join events e on e.id = r.event_id where e.slug = $1`,
      [ev.slug],
    )
    expect(rows).toEqual([{ email: null, hash_len: 32 }])
  })

  it('registers with email (normalized to lowercase)', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug, 'Marko', 'Marković', '  Marko@Example.ORG ')
    expect(r.ok).toBe(true)
    const rows = await db(
      `select r.email from registrations r join events e on e.id = r.event_id where e.slug = $1`,
      [ev.slug],
    )
    expect(rows[0]!.email).toBe('marko@example.org')
  })

  it('never stores the raw token', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug)
    const rows = await db(
      `select count(*)::int as n from registrations where pass_token_hash = extensions.digest($1, 'sha256')`,
      [r.token],
    )
    expect(rows[0]!.n).toBe(1)
    const dump = await db(`select row_to_json(r)::text as j from registrations r`)
    expect(dump.some((d) => String(d.j).includes(r.token))).toBe(false)
  })

  it('issues unique passes for people with the same name', async () => {
    const ev = await createEvent(admin.client)
    const a = await register(ev.slug, 'Jovan', 'Jovanović')
    const b = await register(ev.slug, 'Jovan', 'Jovanović')
    expect(a.ok && b.ok).toBe(true)
    expect(a.token).not.toBe(b.token)
  })

  it('gives independent passes for separate events', async () => {
    const evA = await createEvent(admin.client)
    const evB = await createEvent(admin.client)
    const a = await register(evA.slug, 'Same', 'Person', 'same@example.org')
    const b = await register(evB.slug, 'Same', 'Person', 'same@example.org')
    expect(a.ok && b.ok).toBe(true)
    expect(a.token).not.toBe(b.token)
    const pa = await anonClient().rpc('get_pass', { p_token: a.token })
    const pb = await anonClient().rpc('get_pass', { p_token: b.token })
    expect(pa.data.event.slug).toBe(evA.slug)
    expect(pb.data.event.slug).toBe(evB.slug)
  })

  it('treats a replayed request id as the same registration (double tap / retry)', async () => {
    const ev = await createEvent(admin.client)
    const requestId = randomUUID()
    const first = await register(ev.slug, 'Ana', 'Retry', null, requestId)
    const second = await register(ev.slug, 'Ana', 'Retry', null, requestId)
    expect(first.ok && second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    const rows = await db(
      `select count(*)::int as n from registrations r join events e on e.id = r.event_id where e.slug = $1`,
      [ev.slug],
    )
    expect(rows[0]!.n).toBe(1)
    // The rotated token is the valid one; the superseded token no longer works.
    expect((await anonClient().rpc('get_pass', { p_token: second.token })).data.ok).toBe(true)
    expect((await anonClient().rpc('get_pass', { p_token: first.token })).data.ok).toBe(false)
  })

  it('serializes concurrent duplicate requests into one registration', async () => {
    const ev = await createEvent(admin.client)
    const requestId = randomUUID()
    const results = await Promise.all(
      Array.from({ length: 6 }, () => register(ev.slug, 'Fast', 'Tapper', null, requestId)),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const rows = await db(
      `select count(*)::int as n from registrations r join events e on e.id = r.event_id where e.slug = $1`,
      [ev.slug],
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('validates input server-side', async () => {
    const ev = await createEvent(admin.client)
    expect(await register(ev.slug, '', 'X')).toMatchObject({
      ok: false,
      error: 'invalid_input',
      field: 'first_name',
    })
    expect(await register(ev.slug, 'X', '   ')).toMatchObject({
      ok: false,
      error: 'invalid_input',
      field: 'last_name',
    })
    expect(await register(ev.slug, 'a'.repeat(101), 'X')).toMatchObject({ ok: false, field: 'first_name' })
    expect(await register(ev.slug, 'X', 'Y', 'not-an-email')).toMatchObject({ ok: false, field: 'email' })
    expect(await register(ev.slug, 'Tab\there', 'Y')).toMatchObject({ ok: true }) // whitespace collapsed
    expect(await register(ev.slug, 'Bell\u0007', 'Y')).toMatchObject({ ok: false, field: 'first_name' })
  })

  it('rejects stored-XSS payloads and stores SQL-looking input literally', async () => {
    const ev = await createEvent(admin.client)
    expect(await register(ev.slug, '<img src=x onerror=alert(1)>', 'X')).toMatchObject({
      ok: false,
      field: 'first_name',
    })
    const sqli = `Robert'); DROP TABLE registrations;--`
    const r = await register(ev.slug, sqli, `' OR '1'='1`)
    expect(r.ok).toBe(true)
    const rows = await db(
      `select first_name, last_name from registrations r join events e on e.id = r.event_id where e.slug = $1`,
      [ev.slug],
    )
    expect(rows[0]).toEqual({ first_name: sqli, last_name: `' OR '1'='1` })
    expect((await db(`select to_regclass('public.registrations') is not null as ok`))[0]!.ok).toBe(true)
  })

  it('rejects the honeypot field', async () => {
    const ev = await createEvent(admin.client)
    const { data } = await anonClient().rpc('register_for_event', {
      p_slug: ev.slug,
      p_first_name: 'Bot',
      p_last_name: 'Bot',
      p_website: 'http://spam.example',
    })
    expect(data).toMatchObject({ ok: false, error: 'invalid_input' })
  })

  it('enforces status, windows and capacity', async () => {
    const draft = await createEvent(admin.client, { status: 'draft' })
    const closed = await createEvent(admin.client, { status: 'closed' })
    const notOpen = await createEvent(admin.client, {
      registration_opens_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(await register(draft.slug)).toMatchObject({ ok: false, error: 'event_not_found' })
    expect(await register(closed.slug)).toMatchObject({ ok: false, error: 'registration_closed' })
    expect(await register(notOpen.slug)).toMatchObject({ ok: false, error: 'registration_not_open' })
    expect(await register('does-not-exist')).toMatchObject({ ok: false, error: 'event_not_found' })

    const small = await createEvent(admin.client, { max_attendees: 3 })
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => register(small.slug, 'Cap', `N${i}`)),
    )
    expect(attempts.filter((a) => a.ok)).toHaveLength(3)
    expect(attempts.filter((a) => a.error === 'event_full')).toHaveLength(5)
  })
})

describe('get_pass', () => {
  it('returns pass and event without sensitive fields', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug, 'Ana', 'Pass', 'ana@example.org')
    const { data } = await anonClient().rpc('get_pass', { p_token: r.token.toLowerCase() })
    expect(data.ok).toBe(true)
    expect(data.pass).toMatchObject({
      first_name: 'Ana',
      last_name: 'Pass',
      status: 'registered',
      checked_in_at: null,
    })
    expect(JSON.stringify(data)).not.toMatch(/ana@example\.org|hash|"id"/)
  })

  it('does not find guessed or malformed tokens', async () => {
    for (const t of ['0000000000000000000000000', '000000000000000000000000', 'abc', '', "' or 1=1 --"]) {
      const { data } = await anonClient().rpc('get_pass', { p_token: t })
      expect(data).toEqual({ ok: false, error: 'pass_not_found' })
    }
  })
})
