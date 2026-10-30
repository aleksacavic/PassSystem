import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { stackEnv } from './env'

export const env = stackEnv()

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function anonClient(headers?: Record<string, string>): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, { ...noSession, global: { headers } })
}

export const service = createClient(env.apiUrl, env.serviceKey, noSession)

export async function db<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) {
  const c = new pg.Client({ connectionString: env.dbUrl })
  await c.connect()
  try {
    return (await c.query<T>(sql, params)).rows
  } finally {
    await c.end()
  }
}

export const uid = () => randomUUID().slice(0, 8)

export interface StaffUser {
  id: string
  email: string
  client: SupabaseClient
}

export async function createStaff(opts: { admin?: boolean; label?: string } = {}): Promise<StaffUser> {
  const email = `${opts.label ?? 'staff'}-${uid()}@passsystem.test`
  const password = `Pw-${randomUUID()}1a`
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  if (opts.admin) await db('update public.profiles set is_admin = true where id = $1', [data.user.id])
  const client = createClient(env.apiUrl, env.anonKey, noSession)
  const { error: e2 } = await client.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  return { id: data.user.id, email, client }
}

export interface TestEvent {
  id: string
  slug: string
  name: string
}

export async function createEvent(
  admin: SupabaseClient,
  overrides: Record<string, unknown> = {},
): Promise<TestEvent> {
  const slug = `ev-${uid()}`
  const { data, error } = await admin
    .from('events')
    .insert({
      name: `Event ${slug}`,
      slug,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'published',
      timezone: 'Europe/Belgrade',
      ...overrides,
    })
    .select('id,slug,name')
    .single()
  if (error) throw error
  return data as TestEvent
}

/** The terms_version the public page shows for an event (what the browser sends back). */
export async function termsVersion(slug: string): Promise<string | null> {
  const rows = await db<{ v: string | null }>(
    `select case when terms_required then encode(extensions.digest(convert_to(terms_text, 'UTF8'), 'sha256'), 'hex') end as v
     from public.events where slug = $1`,
    [slug],
  )
  return rows[0]?.v ?? null
}

export async function register(
  slug: string,
  first = 'Ana',
  last = 'Test',
  email: string | null = null,
  requestId: string = randomUUID(),
) {
  const { data, error } = await anonClient().rpc('register_for_event', {
    p_slug: slug,
    p_first_name: first,
    p_last_name: last,
    p_email: email,
    p_request_id: requestId,
    p_accept_terms: true,
    p_terms_version: await termsVersion(slug),
  })
  if (error) throw error
  return data as {
    ok: boolean
    error?: string
    field?: string
    token: string
    replayed: boolean
    registration: { first_name: string; last_name: string; status: string }
  }
}

export async function admit(client: SupabaseClient, eventId: string, token: string) {
  return client.rpc('admit_pass', { p_event_id: eventId, p_token: token })
}

/** What invite-staff does: reserve the invite's generation, then save its role. */
export async function setInviteRole(userId: string, admin: boolean) {
  const rows = await db<{ email: string }>(`select email from auth.users where id = $1`, [userId])
  let generation = 0
  if (rows[0]) {
    const reserved = await service.rpc('begin_invite', { p_email: rows[0].email })
    if (reserved.error) throw reserved.error
    generation = reserved.data as number
  }
  return service.rpc('set_pending_admin', { p_user_id: userId, p_admin: admin, p_generation: generation })
}

/**
 * Per-minute rate limits count in fixed calendar-minute windows (database clock).
 * Call before a burst that must land in one window: waits for the next minute
 * if fewer than 10 seconds of the current one remain.
 */
export async function inFreshRateWindow() {
  const [row] = await db<{ s: number }>(`select extract(second from now())::float8 as s`)
  if (row!.s > 50) await new Promise((r) => setTimeout(r, (61 - row!.s) * 1000))
}
