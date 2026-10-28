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
