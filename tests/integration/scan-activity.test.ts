// The Scan activity list's query, run as the app runs it (listScanActivity) against the real
// database: every scan, a page at a time, searchable by attendee and filterable by result.
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { admit, createEvent, createStaff, register, type StaffUser, type TestEvent } from './helpers'

const app = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return app.client
  },
}))
import { listScanActivity } from '../../src/lib/api'

let admin: StaffUser
let organizer: StaffUser
let ev: TestEvent

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'scan-admin' })
  organizer = await createStaff({ label: 'scan-org' })
  ev = await createEvent(admin.client)
  expect(
    (
      await admin.client.rpc('add_event_staff', {
        p_event_id: ev.id,
        p_email: organizer.email,
        p_role: 'organizer',
      })
    ).error,
  ).toBeNull()
  const ana = await register(ev.slug, 'Ana', 'Petrovic', 'ana@example.test')
  const bob = await register(ev.slug, 'Bob', 'Marley')
  await admit(organizer.client, ev.id, ana.token) // admitted
  await admit(organizer.client, ev.id, ana.token) // already used
  await admit(organizer.client, ev.id, bob.token) // admitted
  await admit(organizer.client, ev.id, 'ZZZZZZZZZZZZZZZZZZZZZZZZ') // invalid, no attendee
  app.client = organizer.client
})

describe('listScanActivity', () => {
  it('lists every scan with the attendee, newest first, and counts them all', async () => {
    const { rows, total } = await listScanActivity({ eventId: ev.id })
    expect(total).toBe(4)
    expect(rows.map((r) => r.result)).toEqual(['invalid', 'admitted', 'already_used', 'admitted'])
    expect(rows[0]!.registration).toBeNull()
    expect(rows[1]!.registration).toMatchObject({ first_name: 'Bob', last_name: 'Marley' })
  })

  it('searches by name, email or several words, and leaves out scans without an attendee', async () => {
    const byName = await listScanActivity({ eventId: ev.id, search: 'petro' })
    expect(byName.total).toBe(2)
    expect(byName.rows.every((r) => r.registration?.first_name === 'Ana')).toBe(true)
    expect((await listScanActivity({ eventId: ev.id, search: 'ana@example' })).total).toBe(2)
    expect((await listScanActivity({ eventId: ev.id, search: 'bob marley' })).total).toBe(1)
    expect((await listScanActivity({ eventId: ev.id, search: 'ana marley' })).total).toBe(0)
  })

  it('filters by result, combined with search, and pages', async () => {
    expect((await listScanActivity({ eventId: ev.id, result: 'admitted' })).total).toBe(2)
    expect((await listScanActivity({ eventId: ev.id, result: 'admitted', search: 'ana' })).total).toBe(1)
    const page2 = await listScanActivity({ eventId: ev.id, page: 1, pageSize: 3 })
    expect(page2.total).toBe(4)
    expect(page2.rows).toHaveLength(1)
  })

  it('shows nothing of the event to staff of another event', async () => {
    const outsider = await createStaff({ label: 'scan-out' })
    app.client = outsider.client
    try {
      expect((await listScanActivity({ eventId: ev.id })).total).toBe(0)
    } finally {
      app.client = organizer.client
    }
  })
})
