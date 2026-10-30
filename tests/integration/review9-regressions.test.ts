// Regression tests for Codex review 9 (docs/CODEX_REVIEW_9.md, R9-01..R9-03).
import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  admit,
  anonClient,
  createEvent,
  createStaff,
  db,
  env,
  inFreshRateWindow,
  register,
  service,
  termsVersion,
  type StaffUser,
} from './helpers'

let admin: StaffUser
let organizer: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'r9-admin' })
  organizer = await createStaff({ label: 'r9-org' })
})

async function organizerOf(slugOverrides: Record<string, unknown> = {}) {
  const ev = await createEvent(admin.client, slugOverrides)
  expect(
    (
      await admin.client.rpc('add_event_staff', {
        p_event_id: ev.id,
        p_email: organizer.email,
        p_role: 'organizer',
      })
    ).error,
  ).toBeNull()
  return ev
}

describe('[R9-01] a stale edit cannot undo an archive', () => {
  it('an edit form saved after the event was archived updates nothing', async () => {
    const ev = await organizerOf()
    const loaded = (
      await organizer.client.from('events').select('updated_at,status').eq('id', ev.id).single()
    ).data!
    expect(loaded.status).toBe('published')

    // Another organizer archives it.
    expect(
      (await admin.client.from('events').update({ status: 'archived' }).eq('id', ev.id)).error,
    ).toBeNull()

    // The old form saves with its stale status, stating the version it loaded (as updateEvent does).
    const stale = await organizer.client
      .from('events')
      .update({ name: 'Renamed', status: 'published' })
      .eq('id', ev.id)
      .eq('updated_at', loaded.updated_at)
      .select('id')
      .maybeSingle()
    expect(stale.error).toBeNull()
    expect(stale.data).toBeNull() // refused: nothing matched
    const [row] = await db<{ status: string; name: string }>(
      `select status, name from public.events where id = $1`,
      [ev.id],
    )
    expect(row).toMatchObject({ status: 'archived', name: ev.name })
    expect((await anonClient().rpc('get_public_event', { p_slug: ev.slug })).data).toMatchObject({
      ok: false,
      error: 'event_not_found',
    })
  })

  it('an edit from a fresh version still applies', async () => {
    const ev = await organizerOf()
    const loaded = (await organizer.client.from('events').select('updated_at').eq('id', ev.id).single()).data!
    const res = await organizer.client
      .from('events')
      .update({ name: 'Renamed' })
      .eq('id', ev.id)
      .eq('updated_at', loaded.updated_at)
      .select('name')
      .maybeSingle()
    expect(res.data).toEqual({ name: 'Renamed' })
  })

  it('an archive from a card showing an older status updates nothing', async () => {
    const ev = await organizerOf()
    await db(`update public.events set status = 'draft' where id = $1`, [ev.id])
    const res = await organizer.client
      .from('events')
      .update({ status: 'archived' })
      .eq('id', ev.id)
      .eq('status', 'published')
      .select('id')
      .maybeSingle()
    expect(res.data).toBeNull()
    expect(
      (await db<{ status: string }>(`select status from public.events where id = $1`, [ev.id]))[0]!.status,
    ).toBe('draft')
  })
})

describe('[R9-02] passes of an archived event are not presented as usable', () => {
  it('get_pass reports the archived event and the Wallet lookup refuses it', async () => {
    const ev = await organizerOf()
    const guest = await register(ev.slug, 'Wanda', 'Wallet')
    expect(
      (await organizer.client.from('events').update({ status: 'archived' }).eq('id', ev.id)).error,
    ).toBeNull()

    const pass = (await anonClient().rpc('get_pass', { p_token: guest.token })).data
    expect(pass).toMatchObject({ ok: true, pass: { status: 'registered' }, event: { status: 'archived' } })
    expect((await service.rpc('wallet_pass_data', { p_token: guest.token })).data).toEqual({
      ok: false,
      error: 'event_archived',
    })

    // Restored (as a draft), the pass can be saved to Wallet again.
    expect(
      (await organizer.client.from('events').update({ status: 'draft' }).eq('id', ev.id)).error,
    ).toBeNull()
    expect((await service.rpc('wallet_pass_data', { p_token: guest.token })).data).toMatchObject({ ok: true })
  })

  it.skipIf(!existsSync('tests/.artifacts/wallet-test-public.pem'))(
    'the google-wallet function answers 409 for an archived event',
    async () => {
      const ev = await organizerOf()
      const guest = await register(ev.slug, 'Wes', 'Wallet')
      await db(`update public.events set status = 'archived' where id = $1`, [ev.id])
      const res = await fetch(`${env.apiUrl}/functions/v1/google-wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: env.anonKey },
        body: JSON.stringify({ token: guest.token }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, error: 'event_archived' })
    },
  )
})

describe('[R9-03] crowd-sized limits, and the hourly limit answered as such', () => {
  it('the migration raised the shared-network limits', async () => {
    // Test setup lifts every limit while the suite runs; check what 011 wrote via its own statements.
    const sql = (await import('node:fs')).readFileSync(
      'supabase/migrations/20261029000011_review9_remediation.sql',
      'utf8',
    )
    for (const [key, value] of [
      ['register_per_ip_per_minute', 600],
      ['register_per_ip_per_hour', 6000],
      ['pass_lookup_per_ip_per_minute', 3000],
      ['public_event_per_ip_per_minute', 3000],
      ['register_per_event_per_minute', 1200],
    ] as const)
      expect(sql).toContain(`set value = ${value} where key = '${key}'`)
  })

  it('a registration refused by the hourly limit says so; one refused by the minute limit says that', async () => {
    const ev = await organizerOf()
    const version = await termsVersion(ev.slug)
    const attempt = (i: number) =>
      anonClient({ 'cf-connecting-ip': '198.51.100.9' }).rpc('register_for_event', {
        p_slug: ev.slug,
        p_first_name: 'Hour',
        p_last_name: `L${i}`,
        p_accept_terms: true,
        p_terms_version: version,
      })
    await db(`delete from private.rate_limit_buckets`)
    await db(`update private.settings set value = 2 where key = 'register_per_ip_per_hour'`)
    try {
      await inFreshRateWindow()
      expect((await attempt(1)).data).toMatchObject({ ok: true })
      expect((await attempt(2)).data).toMatchObject({ ok: true })
      expect((await attempt(3)).data).toMatchObject({ ok: false, error: 'rate_limited', window: 'hour' })
    } finally {
      await db(`update private.settings set value = 100000 where key = 'register_per_ip_per_hour'`)
      await db(`delete from private.rate_limit_buckets`)
    }
    await db(`update private.settings set value = 1 where key = 'register_per_ip_per_minute'`)
    try {
      await inFreshRateWindow()
      expect((await attempt(4)).data).toMatchObject({ ok: true })
      expect((await attempt(5)).data).toMatchObject({ ok: false, error: 'rate_limited', window: 'minute' })
    } finally {
      await db(`update private.settings set value = 100000 where key = 'register_per_ip_per_minute'`)
      await db(`delete from private.rate_limit_buckets`)
    }
  })
})

describe('archive keeps history; only the event’s own organizers can archive', () => {
  it('registrations and scan history survive archive and restore', async () => {
    const ev = await organizerOf()
    const a = await register(ev.slug, 'Kept', 'One')
    await register(ev.slug, 'Kept', 'Two')
    expect((await admit(organizer.client, ev.id, a.token)).error).toBeNull()
    await organizer.client.from('events').update({ status: 'archived' }).eq('id', ev.id)
    await organizer.client.from('events').update({ status: 'draft' }).eq('id', ev.id)
    expect(await db(`select 1 from public.registrations where event_id = $1`, [ev.id])).toHaveLength(2)
    expect(await db(`select 1 from public.admission_logs where event_id = $1`, [ev.id])).toHaveLength(1)
  })

  it('an organizer of a different event cannot archive this one', async () => {
    const other = await createStaff({ label: 'r9-other-org' })
    const theirs = await createEvent(admin.client)
    expect(
      (
        await admin.client.rpc('add_event_staff', {
          p_event_id: theirs.id,
          p_email: other.email,
          p_role: 'organizer',
        })
      ).error,
    ).toBeNull()
    const ev = await createEvent(admin.client)
    const res = await other.client.from('events').update({ status: 'archived' }).eq('id', ev.id).select('id')
    expect(res.data ?? []).toEqual([])
    expect(
      (await db<{ status: string }>(`select status from public.events where id = $1`, [ev.id]))[0]!.status,
    ).toBe('published')
  })
})
