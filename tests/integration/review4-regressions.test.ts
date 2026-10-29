// Regression tests for Codex review 4 (docs/CODEX_REVIEW_4.md, R4-01, R4-03, R4-06).
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  admit,
  anonClient,
  createEvent,
  createStaff,
  db,
  env,
  register,
  service,
  termsVersion,
  uid,
  type StaffUser,
} from './helpers'

let admin: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'r4-admin' })
})

const isAdmin = async (id: string) =>
  (await db<{ is_admin: boolean }>(`select is_admin from public.profiles where id = $1`, [id]))[0]!.is_admin

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

// The three steps invite-staff performs, run separately so they can interleave.
const reserve = async (email: string) =>
  (await service.rpc('begin_invite', { p_email: email })).data as number
async function issueLink(email: string) {
  const { data, error } = await service.auth.admin.generateLink({ type: 'invite', email })
  if (error) throw error
  return { userId: data.user.id, tokenHash: data.properties.hashed_token }
}
const saveRole = async (userId: string, admin: boolean, generation: number) =>
  (await service.rpc('set_pending_admin', { p_user_id: userId, p_admin: admin, p_generation: generation }))
    .data as string
const accept = async (tokenHash: string) =>
  (await anonClient().auth.verifyOtp({ type: 'invite', token_hash: tokenHash })).error

describe('[R4-01] a stale invite request cannot override a newer role or a demotion', () => {
  it('an older administrator invite that finishes after a newer staff invite changes nothing', async () => {
    const email = `r4-a-${uid()}@passsystem.test`
    const genA = await reserve(email)
    const a = await issueLink(email) // administrator invite A, paused before saving its role
    const genB = await reserve(email)
    const b = await issueLink(email) // staff invite B, completes
    expect(await saveRole(b.userId, false, genB)).toBe('cleared')
    expect(await saveRole(a.userId, true, genA)).toBe('stale') // A resumes
    expect(await accept(b.tokenHash)).toBeNull()
    expect(await isAdmin(b.userId)).toBe(false)
  })

  it('an older administrator invite that finishes after acceptance and demotion does not re-grant', async () => {
    const email = `r4-b-${uid()}@passsystem.test`
    const genA = await reserve(email)
    const a = await issueLink(email) // paused
    const genB = await reserve(email)
    const b = await issueLink(email)
    expect(await saveRole(b.userId, true, genB)).toBe('queued')
    expect(await accept(b.tokenHash)).toBeNull()
    expect(await isAdmin(b.userId)).toBe(true)
    expect(
      (await admin.client.rpc('set_user_admin', { p_user_id: b.userId, p_is_admin: false })).error,
    ).toBeNull()
    expect(await saveRole(a.userId, true, genA)).toBe('stale')
    expect(await isAdmin(b.userId)).toBe(false)
  })

  it("a demotion voids the invite's own role save that is still in flight", async () => {
    const email = `r4-d-${uid()}@passsystem.test`
    const gen = await reserve(email)
    const b = await issueLink(email)
    expect(await accept(b.tokenHash)).toBeNull() // accepted before its role was saved
    expect(
      (await admin.client.rpc('set_user_admin', { p_user_id: b.userId, p_is_admin: false })).error,
    ).toBeNull()
    expect(await saveRole(b.userId, true, gen)).toBe('stale')
    expect(await isAdmin(b.userId)).toBe(false)
  })

  it('a queued promotion is not honoured when a newer invite is accepted before saving its own role', async () => {
    const email = `r4-c-${uid()}@passsystem.test`
    const genA = await reserve(email)
    const a = await issueLink(email)
    expect(await saveRole(a.userId, true, genA)).toBe('queued')
    await reserve(email) // newer (staff) invite B, its role not saved yet
    const b = await issueLink(email)
    expect(await accept(b.tokenHash)).toBeNull()
    expect(await isAdmin(b.userId)).toBe(false)
  })

  it('the Edge Function refuses to hand out a superseded invite', async () => {
    const email = `r4-fn-${uid()}@passsystem.test`
    const token = (await admin.client.auth.getSession()).data.session!.access_token
    const invite = (isAdmin: boolean) =>
      fetch(`${env.apiUrl}/functions/v1/invite-staff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.anonKey,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email,
          admin: isAdmin,
          redirectTo: 'http://127.0.0.1:4173/',
          delivery: 'link',
        }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

    // Hold the admin lock so the function stops right before saving the role.
    const holder = new pg.Client({ connectionString: env.dbUrl })
    await holder.connect()
    let first: Awaited<ReturnType<typeof invite>>
    try {
      await holder.query('begin')
      await holder.query(`select pg_advisory_xact_lock(hashtextextended('passsystem:admins', 0))`)
      const pending = invite(true)
      await waitingOn('%set_pending_admin%')
      await reserve(email) // a newer invite for the same address is created meanwhile
      await holder.query('commit')
      first = await pending
    } finally {
      await holder.end()
    }
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ ok: false, error: 'invite_superseded' })
    expect(first.body.link).toBeUndefined()

    const second = await invite(false)
    expect(second.body).toMatchObject({ ok: true, admin: false })
    const link = new URL(second.body.link as string)
    expect(await accept(new URLSearchParams(link.hash.slice(1)).get('token')!)).toBeNull()
    expect(await isAdmin(second.body.user_id as string)).toBe(false)
  })
})

describe('[R4-03] deleting an account leaves no dangling references', () => {
  it("clears the creator of the account's events and every other reference to it", async () => {
    const creator = await createStaff({ admin: true, label: 'r4-creator' })
    const helper = await createStaff({ label: 'r4-helper' })
    const ev = await createEvent(creator.client)
    expect(
      (
        await creator.client.rpc('add_event_staff', {
          p_event_id: ev.id,
          p_email: helper.email,
          p_role: 'operator',
        })
      ).error,
    ).toBeNull()
    const guest = await register(ev.slug, 'Gia', 'Guest')
    expect((await admit(creator.client, ev.id, guest.token)).error).toBeNull()

    expect(
      (await admin.client.rpc('set_user_admin', { p_user_id: creator.id, p_is_admin: false })).error,
    ).toBeNull()
    expect((await service.auth.admin.deleteUser(creator.id)).error).toBeNull()

    const [event] = await db<{ created_by: string | null }>(
      `select created_by from public.events where id = $1`,
      [ev.id],
    )
    expect(event).toEqual({ created_by: null })
    const left = await db(
      `select 'events' t from public.events where created_by = $1
       union all select 'event_staff' from public.event_staff where created_by = $1
       union all select 'checked_in_by' from public.registrations where checked_in_by = $1
       union all select 'revoked_by' from public.registrations where revoked_by = $1
       union all select 'admission_logs' from public.admission_logs where operator_id = $1`,
      [creator.id],
    )
    expect(left).toEqual([])
    // The event and its history are kept.
    expect(await db(`select 1 from public.admission_logs where event_id = $1`, [ev.id])).toHaveLength(1)
  })

  it('the creator still cannot be changed by an update', async () => {
    const other = await createStaff({ label: 'r4-other' })
    const ev = await createEvent(admin.client)
    await db(`update public.events set created_by = $2, name = 'Renamed' where id = $1`, [ev.id, other.id])
    const [row] = await db(`select created_by, name from public.events where id = $1`, [ev.id])
    expect(row).toEqual({ created_by: admin.id, name: 'Renamed' })
  })
})

describe('[R4-06] retries of 003-era registrations match names stored without NFC', () => {
  it('a decomposed accent replays the existing registration instead of adding a second one', async () => {
    const ev = await createEvent(admin.client)
    const requestId = randomUUID()
    const decomposed = 'Café' // as the 003 cleaner stored it (no NFC)
    await db(
      `insert into public.registrations (event_id, first_name, last_name, pass_token_hash, request_id_hash)
       values ($1, $2, 'Legacy', private.hash_secret($3), private.hash_secret($4))`,
      [ev.id, decomposed, `legacy-${uid()}`, requestId],
    )
    const { data, error } = await anonClient().rpc('register_for_event', {
      p_slug: ev.slug,
      p_first_name: decomposed,
      p_last_name: 'Legacy',
      p_request_id: requestId,
      p_accept_terms: true,
      p_terms_version: await termsVersion(ev.slug),
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ ok: true, replayed: true })
    expect(await db(`select 1 from public.registrations where event_id = $1`, [ev.id])).toHaveLength(1)
  })
})
