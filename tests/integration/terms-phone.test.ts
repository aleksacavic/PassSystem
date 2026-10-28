import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { anonClient, createEvent, createStaff, db, termsVersion, type StaffUser } from './helpers'

let admin: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'terms-admin' })
})

const reg = async (slug: string, extra: Record<string, unknown> = {}) =>
  anonClient()
    .rpc('register_for_event', {
      p_slug: slug,
      p_first_name: 'Tia',
      p_last_name: 'Terms',
      p_terms_version: await termsVersion(slug),
      ...extra,
    })
    .then((r) => r.data)

describe('attendance terms', () => {
  it('new events require the default terms, shown on the public page', async () => {
    const ev = await createEvent(admin.client)
    const { data: def } = await admin.client.rpc('default_event_terms')
    expect(def).toMatch(/not political, religious or commercial/)
    expect(def).toMatch(/Federal Decree-Law No\. 45 of 2021/)
    const { data } = await anonClient().rpc('get_public_event', { p_slug: ev.slug })
    expect(data.event).toMatchObject({ terms_required: true, terms_text: def })
  })

  it('registration is refused until the terms are accepted, and acceptance is recorded', async () => {
    const ev = await createEvent(admin.client)
    expect(await reg(ev.slug)).toMatchObject({ ok: false, error: 'terms_not_accepted', field: 'terms' })
    expect(await reg(ev.slug, { p_accept_terms: false })).toMatchObject({
      ok: false,
      error: 'terms_not_accepted',
    })
    const ok = await reg(ev.slug, { p_accept_terms: true })
    expect(ok.ok).toBe(true)
    const [row] = await db<{ accepted: boolean; hash_ok: boolean }>(
      `select r.terms_accepted_at is not null as accepted,
              r.terms_hash = extensions.digest(convert_to(e.terms_text, 'UTF8'), 'sha256') as hash_ok
       from registrations r join events e on e.id = r.event_id where e.id = $1`,
      [ev.id],
    )
    expect(row).toEqual({ accepted: true, hash_ok: true })
  })

  it('organizers can edit the text or switch the requirement off', async () => {
    const ev = await createEvent(admin.client)
    const custom = 'Custom terms: be kind.'
    const upd = await admin.client
      .from('events')
      .update({ terms_text: custom })
      .eq('id', ev.id)
      .select('terms_text')
      .single()
    expect(upd.data?.terms_text).toBe(custom)
    expect((await anonClient().rpc('get_public_event', { p_slug: ev.slug })).data.event.terms_text).toBe(
      custom,
    )
    await admin.client.from('events').update({ terms_required: false }).eq('id', ev.id)
    const pub = (await anonClient().rpc('get_public_event', { p_slug: ev.slug })).data.event
    expect(pub).toMatchObject({ terms_required: false, terms_text: null })
    expect((await reg(ev.slug)).ok).toBe(true) // no acceptance needed now
  })

  it('required terms cannot be empty', async () => {
    const ev = await createEvent(admin.client)
    const res = await admin.client.from('events').update({ terms_text: '   ' }).eq('id', ev.id)
    expect(res.error?.code).toBe('23514')
  })

  it('operators cannot change the terms', async () => {
    const op = await createStaff({ label: 'terms-op' })
    const ev = await createEvent(admin.client)
    await admin.client.rpc('add_event_staff', { p_event_id: ev.id, p_email: op.email, p_role: 'operator' })
    const res = await op.client.from('events').update({ terms_text: 'hacked' }).eq('id', ev.id).select('id')
    expect(res.data ?? []).toEqual([])
    expect((await db(`select terms_text from events where id = $1`, [ev.id]))[0]!.terms_text).not.toBe(
      'hacked',
    )
  })
})

describe('phone number', () => {
  it('is optional and normalized to E.164', async () => {
    const ev = await createEvent(admin.client)
    expect((await reg(ev.slug, { p_accept_terms: true })).ok).toBe(true)
    const cases: [string, string][] = [
      ['+971 50 123 4567', '+971501234567'],
      ['(+44) 20-7946-0958', '+442079460958'],
      ['+381.64.123.4567', '+381641234567'],
    ]
    for (const [input] of cases) {
      const r = await reg(ev.slug, {
        p_accept_terms: true,
        p_phone: input,
        p_last_name: `P${randomUUID().slice(0, 4)}`,
      })
      expect(r.ok, input).toBe(true)
    }
    const rows = await db<{ phone: string }>(
      `select phone from registrations where event_id = $1 and phone is not null order by phone`,
      [ev.id],
    )
    expect(rows.map((r) => r.phone).sort()).toEqual(cases.map(([, stored]) => stored).sort())
  })

  it('rejects numbers without the + country code or with letters', async () => {
    const ev = await createEvent(admin.client)
    for (const bad of [
      '0501234567',
      '971501234567',
      '+0 501234567',
      '+971 50 ABC 4567',
      '+1234',
      '+' + '1'.repeat(16),
    ]) {
      expect(await reg(ev.slug, { p_accept_terms: true, p_phone: bad }), bad).toMatchObject({
        ok: false,
        error: 'invalid_input',
        field: 'phone',
      })
    }
  })

  it('organizers can read the phone; it is part of the replay key', async () => {
    const ev = await createEvent(admin.client)
    const rid = randomUUID()
    await reg(ev.slug, { p_accept_terms: true, p_phone: '+971501234567', p_request_id: rid })
    const other = await reg(ev.slug, { p_accept_terms: true, p_phone: '+971509999999', p_request_id: rid })
    expect(other.replayed).toBe(false) // different phone = different registration
    const { data } = await admin.client
      .from('registrations')
      .select('phone,terms_accepted_at')
      .eq('event_id', ev.id)
    expect(data!.map((r) => r.phone).sort()).toEqual(['+971501234567', '+971509999999'])
  })
})
