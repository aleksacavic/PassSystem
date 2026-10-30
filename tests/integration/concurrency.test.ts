import { beforeAll, describe, expect, it } from 'vitest'
import { admit, createEvent, createStaff, db, register, type StaffUser, type TestEvent } from './helpers'

let admin: StaffUser
let op1: StaffUser
let op2: StaffUser
let ev: TestEvent

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'cc-admin' })
  op1 = await createStaff({ label: 'cc-op1' })
  op2 = await createStaff({ label: 'cc-op2' })
  ev = await createEvent(admin.client)
  for (const op of [op1, op2]) {
    const { error } = await admin.client.rpc('add_event_staff', {
      p_event_id: ev.id,
      p_email: op.email,
      p_role: 'operator',
    })
    expect(error).toBeNull()
  }
})

describe('simultaneous scans', () => {
  it('two operator sessions scanning the same pass at the same time: exactly one admission', async () => {
    for (let round = 0; round < 10; round++) {
      const r = await register(ev.slug, 'Race', `R${round}`)
      const results = await Promise.all([
        admit(op1.client, ev.id, r.token),
        admit(op2.client, ev.id, r.token),
      ])
      const outcomes = results.map((x) => x.data?.result)
      expect(outcomes.sort()).toEqual(['admitted', 'already_used'])
    }
  })

  it('a burst of 20 concurrent scans of one pass admits exactly once', async () => {
    const r = await register(ev.slug, 'Burst', 'Test')
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => admit(i % 2 ? op1.client : op2.client, ev.id, r.token)),
    )
    const admitted = results.filter((x) => x.data?.result === 'admitted')
    expect(admitted).toHaveLength(1)
    expect(results.filter((x) => x.data?.result === 'already_used')).toHaveLength(19)
    const logs = await db(
      `select result, count(*)::int as n from admission_logs l join registrations r on r.id = l.registration_id
       where r.pass_token_hash = extensions.digest($1,'sha256') group by result order by result`,
      [r.token],
    )
    expect(logs).toEqual([
      { result: 'admitted', n: 1 },
      { result: 'already_used', n: 19 },
    ])
  })
})

describe('transaction interleaving (deterministic)', () => {
  it('a scan that arrives while another admission is uncommitted waits and then reports already_used', async () => {
    const pg = (await import('pg')).default
    const { env } = await import('./helpers')
    const r = await register(ev.slug, 'Interleave', 'Test')
    const c1 = new pg.Client({ connectionString: env.dbUrl })
    const c2 = new pg.Client({ connectionString: env.dbUrl })
    await Promise.all([c1.connect(), c2.connect()])
    const asOperator = async (c: InstanceType<typeof pg.Client>, userId: string) => {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      await c.query('set local role authenticated')
    }
    try {
      await asOperator(c1, op1.id)
      const first = await c1.query(`select public.admit_pass($1, $2) as r`, [ev.id, r.token])
      expect(first.rows[0].r.result).toBe('admitted') // not yet committed

      await asOperator(c2, op2.id)
      let secondDone = false
      const second = c2.query(`select public.admit_pass($1, $2) as r`, [ev.id, r.token]).then((x) => {
        secondDone = true
        return x
      })
      await new Promise((res) => setTimeout(res, 300))
      expect(secondDone).toBe(false) // blocked on the row lock

      await c1.query('commit')
      const res2 = await second
      expect(res2.rows[0].r.result).toBe('already_used')
      await c2.query('commit')
    } finally {
      await Promise.all([c1.end(), c2.end()])
    }
  })
})
