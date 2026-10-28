// Regression tests for Codex review 2 (docs/CODEX_REVIEW_2.md, R2-01..R2-06).
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
let operator: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'r2-admin' })
  operator = await createStaff({ label: 'r2-op' })
})

const isAdmin = async (id: string) =>
  (await db<{ is_admin: boolean }>(`select is_admin from public.profiles where id = $1`, [id]))[0]!.is_admin

describe('[R2-01] administrator invites are single-use', () => {
  it('a demoted invitee is not re-promoted by a later email change', async () => {
    const { data } = await service.auth.admin.createUser({ email: `r2-inv-${uid()}@passsystem.test` })
    const id = data.user!.id
    expect((await service.rpc('mark_pending_admin', { p_user_id: id })).error).toBeNull()
    await db(`update auth.users set email_confirmed_at = now() where id = $1`, [id]) // invite accepted
    expect(await isAdmin(id)).toBe(true)
    expect(await db(`select 1 from private.pending_admin_invites where user_id = $1`, [id])).toHaveLength(0)

    expect((await admin.client.rpc('set_user_admin', { p_user_id: id, p_is_admin: false })).error).toBeNull()
    await db(`update auth.users set email = $2 where id = $1`, [id, `r2-changed-${uid()}@passsystem.test`])
    await db(
      `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"pending_admin": true}' where id = $1`,
      [id],
    )
    expect(await isAdmin(id)).toBe(false)
  })

  it('only the service role can mark a pending administrator', async () => {
    const { data } = await service.auth.admin.createUser({ email: `r2-inv2-${uid()}@passsystem.test` })
    const res = await admin.client.rpc('mark_pending_admin', { p_user_id: data.user!.id })
    expect(res.error).not.toBeNull()
    expect(
      await db(`select 1 from private.pending_admin_invites where user_id = $1`, [data.user!.id]),
    ).toHaveLength(0)
  })
})

describe('[R2-02] a scan attempt is bound to its credential', () => {
  it('reusing an attempt id with a different or invalid credential is refused', async () => {
    const ev = await createEvent(admin.client)
    await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: operator.email,
      p_role: 'operator',
    })
    const a = await register(ev.slug, 'Ana', 'First')
    const b = await register(ev.slug, 'Bo', 'Second')
    const attempt = randomUUID()
    const call = (token: string) =>
      operator.client.rpc('admit_pass', { p_event_id: ev.id, p_token: token, p_attempt_id: attempt })

    expect((await call(a.token)).data.result).toBe('admitted')
    expect((await call('NOT-A-PASS')).error?.hint).toBe('attempt_conflict')
    expect((await call(b.token)).error?.hint).toBe('attempt_conflict')
    // B was not touched, and the honest retry still replays A's admission.
    const [regB] = await db(
      `select status from public.registrations where event_id = $1 and first_name = 'Bo'`,
      [ev.id],
    )
    expect(regB).toEqual({ status: 'registered' })
    const retry = await call(a.token)
    expect(retry.data).toMatchObject({ result: 'admitted', replayed: true })
    expect((await admit(operator.client, ev.id, b.token)).data.result).toBe('admitted')
  })

  it('concurrent uses of one attempt id with two passes admit at most one', async () => {
    const ev = await createEvent(admin.client)
    await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: operator.email,
      p_role: 'operator',
    })
    const a = await register(ev.slug, 'Cy', 'One')
    const b = await register(ev.slug, 'Di', 'Two')
    const attempt = randomUUID()
    const results = await Promise.all(
      [a.token, b.token].map((t) =>
        operator.client.rpc('admit_pass', { p_event_id: ev.id, p_token: t, p_attempt_id: attempt }),
      ),
    )
    expect(results.filter((r) => r.data?.result === 'admitted')).toHaveLength(1)
    expect(results.filter((r) => r.error?.hint === 'attempt_conflict')).toHaveLength(1)
    const [{ n }] = await db<{ n: number }>(
      `select count(*)::int as n from public.registrations where event_id = $1 and status = 'checked_in'`,
      [ev.id],
    )
    expect(n).toBe(1)
  })
})

describe('[R2-03] consent is bound to the terms shown', () => {
  it('an edit between display and submit is refused, and every version is kept', async () => {
    const ev = await createEvent(admin.client, { terms_text: 'Terms A' })
    const shown = await termsVersion(ev.slug)
    const { data: pub } = await anonClient().rpc('get_public_event', { p_slug: ev.slug })
    expect(pub.event.terms_version).toBe(shown)

    expect(
      (await admin.client.from('events').update({ terms_text: 'Terms B' }).eq('id', ev.id)).error,
    ).toBeNull()
    const base = { p_slug: ev.slug, p_first_name: 'Tess', p_last_name: 'Terms', p_accept_terms: true }
    const stale = (await anonClient().rpc('register_for_event', { ...base, p_terms_version: shown })).data
    expect(stale).toMatchObject({ ok: false, error: 'terms_changed', field: 'terms' })
    expect(stale.event.terms_text).toBe('Terms B')
    expect((await anonClient().rpc('register_for_event', base)).data).toMatchObject({
      error: 'terms_changed',
    })

    const ok = (
      await anonClient().rpc('register_for_event', { ...base, p_terms_version: stale.event.terms_version })
    ).data
    expect(ok.ok).toBe(true)
    const [row] = await db<{ matches: boolean }>(
      `select r.terms_hash = extensions.digest(convert_to('Terms B', 'UTF8'), 'sha256') as matches
       from public.registrations r where r.event_id = $1`,
      [ev.id],
    )
    expect(row!.matches).toBe(true)
    const versions = await db<{ terms_text: string }>(
      `select terms_text from private.event_terms_versions where event_id = $1 order by first_seen_at, terms_text`,
      [ev.id],
    )
    expect(versions.map((v) => v.terms_text).sort()).toEqual(['Terms A', 'Terms B'])
  })

  it('a retry of a completed registration still returns the pass after the terms change', async () => {
    const ev = await createEvent(admin.client, { terms_text: 'Old terms' })
    const requestId = randomUUID()
    const body = {
      p_slug: ev.slug,
      p_first_name: 'Ray',
      p_last_name: 'Retry',
      p_request_id: requestId,
      p_accept_terms: true,
      p_terms_version: await termsVersion(ev.slug),
    }
    expect((await anonClient().rpc('register_for_event', body)).data.ok).toBe(true)
    await admin.client.from('events').update({ terms_text: 'New terms' }).eq('id', ev.id)
    expect((await anonClient().rpc('register_for_event', body)).data).toMatchObject({
      ok: true,
      replayed: true,
    })
  })
})

describe('[R2-04] administrator accounts cannot be deleted', () => {
  it('the database refuses to delete an administrator, whatever the path', async () => {
    const other = await createStaff({ admin: true, label: 'r2-keep' })
    const { error } = await service.auth.admin.deleteUser(other.id)
    expect(error).not.toBeNull()
    expect(await db(`select 1 from auth.users where id = $1`, [other.id])).toHaveLength(1)
    // After demotion the account can be removed.
    await admin.client.rpc('set_user_admin', { p_user_id: other.id, p_is_admin: false })
    expect((await service.auth.admin.deleteUser(other.id)).error).toBeNull()
  })
})

describe('[R2-05] retries made before the upgrade are still recognised', () => {
  const legacy = async (format: '003' | '004') => {
    const ev = await createEvent(admin.client)
    const requestId = randomUUID()
    const key = format === '003' ? requestId : `${requestId}\u001fleo\u001flegacy\u001f`
    await db(
      `insert into public.registrations (event_id, first_name, last_name, pass_token_hash, request_id_hash)
       values ($1, 'Leo', 'Legacy', extensions.digest(convert_to($2, 'UTF8'), 'sha256'),
               extensions.digest(convert_to($3, 'UTF8'), 'sha256'))`,
      [ev.id, `old-${randomUUID()}`, key],
    )
    const retry = (first: string) =>
      anonClient().rpc('register_for_event', {
        p_slug: ev.slug,
        p_first_name: first,
        p_last_name: 'Legacy',
        p_request_id: requestId,
        p_accept_terms: true,
      })
    return { ev, retry }
  }

  it('a 004-format key (names + email, no phone) replays', async () => {
    const { ev, retry } = await legacy('004')
    expect((await retry('Leo')).data).toMatchObject({ ok: true, replayed: true })
    expect(await db(`select 1 from public.registrations where event_id = $1`, [ev.id])).toHaveLength(1)
  })

  it('a 003-format key (id only) replays only with the same details', async () => {
    const { ev, retry } = await legacy('003')
    expect((await retry('Leo')).data).toMatchObject({ ok: true, replayed: true })
    // Same id, different person: not a replay of Leo's pass.
    const other = (await retry('Mia')).data
    expect(other.replayed).not.toBe(true)
    expect(
      await db(`select 1 from public.registrations where event_id = $1 and first_name = 'Leo'`, [ev.id]),
    ).toHaveLength(1)
  })
})

describe('[R2-06] event edits are ordered with registrations', () => {
  it('a registration queued behind an archival sees the archived event', async () => {
    const ev = await createEvent(admin.client)
    const version = await termsVersion(ev.slug)
    const holder = new pg.Client({ connectionString: env.dbUrl })
    const archiver = new pg.Client({ connectionString: env.dbUrl })
    await holder.connect()
    await archiver.connect()
    try {
      await holder.query('begin')
      await holder.query('select private.lock_event_capacity($1)', [ev.id])
      const archival = archiver.query(`update public.events set status = 'archived' where id = $1`, [ev.id])
      const waiting = async (pattern: string) => {
        for (let i = 0; i < 50; i++) {
          const rows = await db(
            `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1`,
            [pattern],
          )
          if (rows.length) return
          await new Promise((r) => setTimeout(r, 50))
        }
        throw new Error(`nothing waiting for ${pattern}`)
      }
      await waiting("%status = 'archived'%")
      // Builders are lazy: .then() sends the request now.
      const registration = anonClient()
        .rpc('register_for_event', {
          p_slug: ev.slug,
          p_first_name: 'Queued',
          p_last_name: 'Guest',
          p_accept_terms: true,
          p_terms_version: version,
        })
        .then((r) => r)
      await waiting('%register_for_event%')
      await holder.query('commit')
      await archival
      expect((await registration).data).toMatchObject({ ok: false, error: 'event_not_found' })
      expect(await db(`select 1 from public.registrations where event_id = $1`, [ev.id])).toHaveLength(0)
    } finally {
      await holder.end()
      await archiver.end()
    }
  })

  it('whitespace-only phone input counts as no phone', async () => {
    const ev = await createEvent(admin.client)
    const { data } = await anonClient().rpc('register_for_event', {
      p_slug: ev.slug,
      p_first_name: 'Tab',
      p_last_name: 'Phone',
      p_phone: '\t ',
      p_accept_terms: true,
      p_terms_version: await termsVersion(ev.slug),
    })
    expect(data.ok).toBe(true)
  })
})
