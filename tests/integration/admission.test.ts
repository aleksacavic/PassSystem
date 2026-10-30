import { beforeAll, describe, expect, it } from 'vitest'
import {
  admit,
  anonClient,
  createEvent,
  createStaff,
  db,
  register,
  type StaffUser,
  type TestEvent,
} from './helpers'

let admin: StaffUser
let operator: StaffUser
let outsider: StaffUser
let evA: TestEvent
let evB: TestEvent

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'adm-admin' })
  operator = await createStaff({ label: 'adm-operator' })
  outsider = await createStaff({ label: 'adm-outsider' })
  evA = await createEvent(admin.client, { name: 'Event A' })
  evB = await createEvent(admin.client, { name: 'Event B' })
  const { error } = await admin.client.rpc('add_event_staff', {
    p_event_id: evA.id,
    p_email: operator.email,
    p_role: 'operator',
  })
  expect(error).toBeNull()
})

describe('admit_pass', () => {
  it('admits a valid pass once, then reports already used with the original time', async () => {
    const r = await register(evA.slug, 'Ana', 'Door')
    const first = await admit(operator.client, evA.id, r.token)
    expect(first.error).toBeNull()
    expect(first.data).toMatchObject({
      result: 'admitted',
      attendee: { first_name: 'Ana', last_name: 'Door' },
      event: { id: evA.id },
    })
    expect(first.data.checked_in_at).toBeTruthy()

    const second = await admit(operator.client, evA.id, r.token)
    expect(second.data).toMatchObject({ result: 'already_used', attendee: { first_name: 'Ana' } })
    expect(second.data.checked_in_at).toBe(first.data.checked_in_at)

    const reg = await db(
      `select status, checked_in_by from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    expect(reg[0]).toEqual({ status: 'checked_in', checked_in_by: operator.id })

    const pass = await anonClient().rpc('get_pass', { p_token: r.token })
    expect(pass.data.pass.status).toBe('checked_in')
  })

  it('accepts the formatted/lowercase code typed manually', async () => {
    const r = await register(evA.slug, 'Manual', 'Entry')
    const formatted = r.token.match(/.{4}/g)!.join('-').toLowerCase()
    expect((await admit(operator.client, evA.id, formatted)).data.result).toBe('admitted')
  })

  it('rejects a pass from another event and does not admit it there', async () => {
    const r = await register(evA.slug, 'Wrong', 'Door')
    const res = await admit(admin.client, evB.id, r.token)
    expect(res.data.result).toBe('wrong_event')
    // admin can see both events, so identity is shown
    expect(res.data.attendee).toMatchObject({ first_name: 'Wrong' })
    const reg = await db(
      `select status from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    expect(reg[0]!.status).toBe('registered')
    // still valid for its own event
    expect((await admit(operator.client, evA.id, r.token)).data.result).toBe('admitted')
  })

  it('a pass from Event B cannot admit to Event A (operator only sees "different event")', async () => {
    const r = await register(evB.slug, 'Other', 'Event')
    const res = await admit(operator.client, evA.id, r.token)
    expect(res.data.result).toBe('wrong_event')
    expect(res.data.attendee).toBeNull()
    expect(res.data.reason).not.toContain('Event B')
  })

  it('rejects revoked passes; restore makes them valid again', async () => {
    const r = await register(evA.slug, 'Revoked', 'Person')
    const [{ id }] = await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    expect((await admin.client.rpc('revoke_registration', { p_registration_id: id })).error).toBeNull()
    expect((await admit(operator.client, evA.id, r.token)).data.result).toBe('revoked')
    expect((await anonClient().rpc('get_pass', { p_token: r.token })).data.pass.status).toBe('revoked')
    expect((await admin.client.rpc('restore_registration', { p_registration_id: id })).error).toBeNull()
    expect((await admit(operator.client, evA.id, r.token)).data.result).toBe('admitted')
    // checked-in passes cannot be revoked
    const again = await admin.client.rpc('revoke_registration', { p_registration_id: id })
    expect(again.error?.hint).toBe('invalid_state')
  })

  it('reissue invalidates the old credential', async () => {
    const r = await register(evA.slug, 'Lost', 'Phone')
    const [{ id }] = await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    const { data, error } = await admin.client.rpc('reissue_pass', { p_registration_id: id })
    expect(error).toBeNull()
    expect(data.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/)
    expect((await admit(operator.client, evA.id, r.token)).data.result).toBe('invalid')
    expect((await admit(operator.client, evA.id, data.token)).data.result).toBe('admitted')
  })

  it('rejects invalid and malformed credentials', async () => {
    for (const t of ['ZZZZZZZZZZZZZZZZZZZZZZZZ', 'hello', '', 'https://evil.example/x']) {
      const res = await admit(operator.client, evA.id, t)
      expect(res.data.result).toBe('invalid')
      expect(res.data.attendee).toBeNull()
    }
  })

  it('logs every attempt without raw tokens', async () => {
    const r = await register(evA.slug, 'Log', 'Me')
    await admit(operator.client, evA.id, r.token)
    await admit(operator.client, evA.id, r.token)
    await admit(operator.client, evA.id, 'not-a-token')
    const logs = await db<{
      result: string
      operator_id: string
      registration_id: string | null
      details: unknown
    }>(
      `select result, operator_id, registration_id, details from admission_logs where event_id = $1 order by attempted_at desc limit 3`,
      [evA.id],
    )
    expect(logs.map((l) => l.result)).toEqual(['invalid', 'already_used', 'admitted'])
    expect(logs.every((l) => l.operator_id === operator.id)).toBe(true)
    expect(logs[0]!.registration_id).toBeNull()
    const all = await db(`select row_to_json(l)::text as j from admission_logs l`)
    expect(all.some((x) => String(x.j).includes(r.token))).toBe(false)
  })

  it('updates event statistics', async () => {
    const ev = await createEvent(admin.client)
    const r1 = await register(ev.slug, 'S', 'One')
    await register(ev.slug, 'S', 'Two')
    const r3 = await register(ev.slug, 'S', 'Three')
    await admit(admin.client, ev.id, r1.token)
    const [{ id }] = await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r3.token],
    )
    await admin.client.rpc('revoke_registration', { p_registration_id: id })
    const { data } = await admin.client.rpc('get_event_summaries', { p_event_id: ev.id })
    expect(data[0]).toMatchObject({
      registered_count: 2,
      checked_in_count: 1,
      revoked_count: 1,
      my_role: 'admin',
    })
  })
})

describe('scanner authorization', () => {
  it('requires authentication', async () => {
    const r = await register(evA.slug)
    const res = await admit(anonClient(), evA.id, r.token)
    expect(res.error?.code).toBe('42501')
    expect(res.data).toBeNull()
  })

  it('rejects staff who are not assigned to the event', async () => {
    const r = await register(evA.slug)
    const res = await admit(outsider.client, evA.id, r.token)
    expect(res.error?.hint).toBe('not_authorized')
    // operator of A is not staff of B
    const rb = await register(evB.slug)
    expect((await admit(operator.client, evB.id, rb.token)).error?.hint).toBe('not_authorized')
    const status = await db(
      `select status from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    expect(status[0]!.status).toBe('registered')
  })

  it('blocks scanning for archived events', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug)
    await admin.client.from('events').update({ status: 'archived' }).eq('id', ev.id)
    expect((await admit(admin.client, ev.id, r.token)).error?.hint).toBe('event_archived')
  })
})
