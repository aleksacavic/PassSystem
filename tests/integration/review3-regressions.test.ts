// Regression tests for Codex review 3 (docs/CODEX_REVIEW_3.md, R3-01..R3-03).
import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  anonClient,
  createEvent,
  createStaff,
  db,
  env,
  service,
  termsVersion,
  uid,
  type StaffUser,
} from './helpers'

let admin: StaffUser
let staff: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'r3-admin' })
  staff = await createStaff({ label: 'r3-staff' })
})

async function waitingOn(pattern: string) {
  for (let i = 0; i < 60; i++) {
    const rows = await db(
      `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1`,
      [pattern],
    )
    if (rows.length) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`nothing waiting for ${pattern}`)
}

const isAdmin = async (id: string) =>
  (await db<{ is_admin: boolean }>(`select is_admin from public.profiles where id = $1`, [id]))[0]!.is_admin
const pending = async (id: string) =>
  (await db(`select 1 from private.pending_admin_invites where user_id = $1`, [id])).length === 1

describe('[R3-01] event edits and registrations cannot deadlock', () => {
  it('a slug change while a registration holds the capacity lock completes, and so does the registration', async () => {
    const ev = await createEvent(admin.client)
    const version = await termsVersion(ev.slug)
    const registrar = new pg.Client({ connectionString: env.dbUrl })
    await registrar.connect()
    try {
      await registrar.query('begin')
      await registrar.query('select private.lock_event_capacity($1)', [ev.id])
      // The edit does not wait for the capacity lock any more.
      const newSlug = `${ev.slug}-moved`
      expect((await admin.client.from('events').update({ slug: newSlug }).eq('id', ev.id)).error).toBeNull()
      const { rows } = await registrar.query(
        `select public.register_for_event($1, 'Dee', 'Lock', null, null, null, null, true, $2) as r`,
        [newSlug, version],
      )
      await registrar.query('commit')
      expect(rows[0].r).toMatchObject({ ok: true })
    } finally {
      await registrar.end()
    }
  })

  it('a registration that arrives during an uncommitted slug change waits, then succeeds', async () => {
    const ev = await createEvent(admin.client)
    const version = await termsVersion(ev.slug)
    const editor = new pg.Client({ connectionString: env.dbUrl })
    await editor.connect()
    try {
      await editor.query('begin')
      await editor.query(`update public.events set slug = $2 where id = $1`, [ev.id, `${ev.slug}-x`])
      const registration = anonClient()
        .rpc('register_for_event', {
          p_slug: ev.slug,
          p_first_name: 'Eve',
          p_last_name: 'Edit',
          p_accept_terms: true,
          p_terms_version: version,
        })
        .then((r) => r)
      await waitingOn('%register_for_event%')
      await editor.query('commit')
      const res = await registration
      expect(res.error).toBeNull()
      expect(res.data).toMatchObject({ ok: true })
    } finally {
      await editor.end()
    }
  })
})

describe('[R3-02] an administrator invite survives a concurrent acceptance', () => {
  it('marking waits for an acceptance in progress, then grants the rights', async () => {
    const { data } = await service.auth.admin.createUser({ email: `r3-race-${uid()}@passsystem.test` })
    const id = data.user!.id
    const accepter = new pg.Client({ connectionString: env.dbUrl })
    await accepter.connect()
    try {
      await accepter.query('begin')
      await accepter.query(`update auth.users set email_confirmed_at = now() where id = $1`, [id]) // trigger ran
      const mark = service.rpc('set_pending_admin', { p_user_id: id, p_admin: true }).then((r) => r)
      await waitingOn('%set_pending_admin%')
      await accepter.query('commit')
      const res = await mark
      expect(res.error).toBeNull()
      expect(res.data).toBe('granted')
      expect(await isAdmin(id)).toBe(true)
      expect(await pending(id)).toBe(false)
    } finally {
      await accepter.end()
    }
  })

  it('reports queued, granted and unchanged outcomes', async () => {
    const { data } = await service.auth.admin.createUser({ email: `r3-out-${uid()}@passsystem.test` })
    const id = data.user!.id
    expect((await service.rpc('set_pending_admin', { p_user_id: id, p_admin: true })).data).toBe('queued')
    await db(`update auth.users set email_confirmed_at = now() where id = $1`, [id])
    expect(await isAdmin(id)).toBe(true)
    expect((await service.rpc('set_pending_admin', { p_user_id: id, p_admin: false })).data).toBe('unchanged')
    expect(await isAdmin(id)).toBe(true) // demotion goes through set_user_admin, not invites
    expect(
      (await service.rpc('set_pending_admin', { p_user_id: crypto.randomUUID(), p_admin: true })).data,
    ).toBe('not_found')
  })
})

describe('[R3-03] the latest invite decides the role', () => {
  async function invite(body: Record<string, unknown>) {
    const token = (await admin.client.auth.getSession()).data.session!.access_token
    const res = await fetch(`${env.apiUrl}/functions/v1/invite-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ redirectTo: 'http://127.0.0.1:4173/', delivery: 'link', ...body }),
    })
    return (await res.json()) as { ok: boolean; user_id: string; admin: boolean; link: string }
  }
  const tokenOf = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get('token')!

  it('re-inviting an administrator invite as staff removes the pending rights', async () => {
    const email = `r3-down-${uid()}@passsystem.test`
    const first = await invite({ email, admin: true })
    expect(first.admin).toBe(true)
    expect(await pending(first.user_id)).toBe(true)
    const second = await invite({ email, admin: false })
    expect(second).toMatchObject({ ok: true, admin: false, user_id: first.user_id })
    expect(await pending(first.user_id)).toBe(false)
    expect(
      (await anonClient().auth.verifyOtp({ type: 'invite', token_hash: tokenOf(second.link) })).error,
    ).toBeNull()
    expect(await isAdmin(first.user_id)).toBe(false)
  })

  it('re-inviting a staff invite as administrator grants rights on acceptance', async () => {
    const email = `r3-up-${uid()}@passsystem.test`
    const first = await invite({ email, admin: false })
    expect(first.admin).toBe(false)
    const second = await invite({ email, admin: true })
    expect(second.admin).toBe(true)
    expect(
      (await anonClient().auth.verifyOtp({ type: 'invite', token_hash: tokenOf(second.link) })).error,
    ).toBeNull()
    expect(await isAdmin(first.user_id)).toBe(true)
  })

  it('administrators can see which pending invites are administrator invites; staff cannot', async () => {
    const email = `r3-list-${uid()}@passsystem.test`
    const created = await invite({ email, admin: true })
    const { data, error } = await admin.client.rpc('pending_admin_invites')
    expect(error).toBeNull()
    expect(data).toContain(created.user_id)
    const denied = await staff.client.rpc('pending_admin_invites')
    expect(denied.error?.code).toBe('42501')
  })
})
