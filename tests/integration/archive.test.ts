// Archive / restore from the Events page: an event's organizers may, its operators may not.
import { beforeAll, describe, expect, it } from 'vitest'
import { createEvent, createStaff, db, type StaffUser } from './helpers'

let admin: StaffUser
let organizer: StaffUser
let operator: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'arch-admin' })
  organizer = await createStaff({ label: 'arch-org' })
  operator = await createStaff({ label: 'arch-op' })
})

const statusOf = async (id: string) =>
  (await db<{ status: string }>(`select status from public.events where id = $1`, [id]))[0]!.status

describe('archiving an event', () => {
  it('an organizer can archive and restore their event; data is kept', async () => {
    const ev = await createEvent(admin.client)
    for (const [user, role] of [
      [organizer, 'organizer'],
      [operator, 'operator'],
    ] as const)
      expect(
        (await admin.client.rpc('add_event_staff', { p_event_id: ev.id, p_email: user.email, p_role: role }))
          .error,
      ).toBeNull()

    expect(
      (await organizer.client.from('events').update({ status: 'archived' }).eq('id', ev.id)).error,
    ).toBeNull()
    expect(await statusOf(ev.id)).toBe('archived')
    expect(
      (await organizer.client.from('events').update({ status: 'draft' }).eq('id', ev.id)).error,
    ).toBeNull()
    expect(await statusOf(ev.id)).toBe('draft')
  })

  it('an operator cannot archive the event', async () => {
    const ev = await createEvent(admin.client)
    expect(
      (
        await admin.client.rpc('add_event_staff', {
          p_event_id: ev.id,
          p_email: operator.email,
          p_role: 'operator',
        })
      ).error,
    ).toBeNull()
    const res = await operator.client
      .from('events')
      .update({ status: 'archived' })
      .eq('id', ev.id)
      .select('id')
    expect(res.data ?? []).toEqual([]) // RLS: no row is updated
    expect(await statusOf(ev.id)).toBe('published')
  })
})
