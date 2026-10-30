import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { admit, createEvent, createStaff, db, env, register, service, uid, type StaffUser } from './helpers'

let admin: StaffUser
let staff: StaffUser

async function removeStaff(token: string | null, body: unknown) {
  const res = await fetch(`${env.apiUrl}/functions/v1/remove-staff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

const tokenOf = async (u: StaffUser) => (await u.client.auth.getSession()).data.session!.access_token
const accountExists = async (id: string) =>
  (await db(`select 1 from auth.users where id = $1`, [id])).length === 1

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'rm-admin' })
  staff = await createStaff({ label: 'rm-staff' })
})

describe('remove-staff Edge Function', () => {
  it('rejects anonymous callers and non-administrators', async () => {
    expect((await removeStaff(null, { userId: staff.id })).status).toBe(401)
    const other = await createStaff({ label: 'rm-other' })
    const res = await removeStaff(await tokenOf(staff), { userId: other.id })
    expect(res.status).toBe(403)
    expect(res.body?.error).toBe('admin_required')
    expect(await accountExists(other.id)).toBe(true)
  })

  it('removes a staff member: no sign-in, no event access, history kept', async () => {
    const op = await createStaff({ label: 'rm-op' })
    const ev = await createEvent(admin.client)
    const add = await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: op.email,
      p_role: 'operator',
    })
    expect(add.error).toBeNull()
    const pass = await register(ev.slug)
    expect((await admit(op.client, ev.id, pass.token)).error).toBeNull()

    const res = await removeStaff(await tokenOf(admin), { userId: op.id })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, user_id: op.id, email: op.email })

    expect(await accountExists(op.id)).toBe(false)
    expect(await db(`select 1 from public.profiles where id = $1`, [op.id])).toHaveLength(0)
    expect(await db(`select 1 from public.event_staff where user_id = $1`, [op.id])).toHaveLength(0)
    // The check-in and its log survive; only the operator reference is cleared.
    const [reg] = await db<{ status: string; checked_in_by: string | null }>(
      `select status, checked_in_by from public.registrations where event_id = $1`,
      [ev.id],
    )
    expect(reg).toEqual({ status: 'checked_in', checked_in_by: null })
    const logs = await db(`select operator_id from public.admission_logs where event_id = $1`, [ev.id])
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l) => l.operator_id === null)).toBe(true)

    // Their still-unexpired session no longer reaches the event.
    const { data: rows } = await op.client.from('events').select('id').eq('id', ev.id)
    expect(rows).toEqual([])
  })

  it('cancels a pending invite', async () => {
    const email = `rm-invite-${uid()}@passsystem.test`
    const { data, error } = await service.auth.admin.inviteUserByEmail(email)
    expect(error).toBeNull()
    const res = await removeStaff(await tokenOf(admin), { userId: data.user!.id })
    expect(res.status).toBe(200)
    expect(await accountExists(data.user!.id)).toBe(false)
  })

  it('refuses administrators, self-removal, unknown and malformed ids', async () => {
    const otherAdmin = await createStaff({ admin: true, label: 'rm-admin2' })
    const adm = await removeStaff(await tokenOf(admin), { userId: otherAdmin.id })
    expect(adm.status).toBe(409)
    expect(adm.body?.error).toBe('remove_admin_first')
    expect(await accountExists(otherAdmin.id)).toBe(true)

    const self = await removeStaff(await tokenOf(admin), { userId: admin.id })
    expect(self.status).toBe(400)
    expect(self.body?.error).toBe('self_removal')

    const unknown = await removeStaff(await tokenOf(admin), { userId: randomUUID() })
    expect(unknown.status).toBe(404)

    for (const userId of ['', 'not-a-uuid', 42, null]) {
      const res = await removeStaff(await tokenOf(admin), { userId })
      expect(res.status, String(userId)).toBe(400)
    }
  })
})
