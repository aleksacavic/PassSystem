import { supabase } from './supabase'
import { ApiError, describeError, errorCode, messageFor } from './errors'
import type {
  AdmissionLog,
  AdmissionResponse,
  EventInput,
  EventRow,
  EventSummary,
  PassView,
  Profile,
  PublicEvent,
  Registration,
  RegistrationState,
  RegistrationStatus,
  StaffMember,
  StaffRole,
} from './types'

type RpcFailure = { ok: false; error: string; field?: string }

function fail(error: unknown): never {
  const e = error as { hint?: string; code?: string; message?: string }
  throw new ApiError(describeError(error), errorCode(e as never))
}

/* ------------------------------------------------------------------ public */

export async function getPublicEvent(
  slug: string,
): Promise<{ event: PublicEvent; registrationState: RegistrationState }> {
  const { data, error } = await supabase.rpc('get_public_event', { p_slug: slug })
  if (error) fail(error)
  const res = data as { ok: true; event: PublicEvent; registration_state: RegistrationState } | RpcFailure
  if (!res.ok) throw new ApiError(messageFor(res.error), res.error)
  return { event: res.event, registrationState: res.registration_state }
}

export interface RegistrationResult {
  token: string
  replayed: boolean
  registration: { first_name: string; last_name: string; status: RegistrationStatus; registered_at: string }
  event: PublicEvent
}

export async function registerForEvent(input: {
  slug: string
  firstName: string
  lastName: string
  email: string
  requestId: string
  website: string
}): Promise<RegistrationResult> {
  const { data, error } = await supabase.rpc('register_for_event', {
    p_slug: input.slug,
    p_first_name: input.firstName,
    p_last_name: input.lastName,
    p_email: input.email || null,
    p_request_id: input.requestId,
    p_website: input.website || null,
  })
  if (error) fail(error)
  const res = data as ({ ok: true } & RegistrationResult) | RpcFailure
  if (!res.ok) {
    const err = new ApiError(messageFor(res.error), res.error) as ApiError & { field?: string }
    err.field = res.field
    throw err
  }
  return res
}

export async function getPass(token: string): Promise<{ pass: PassView; event: PublicEvent }> {
  const { data, error } = await supabase.rpc('get_pass', { p_token: token })
  if (error) fail(error)
  const res = data as { ok: true; pass: PassView; event: PublicEvent } | RpcFailure
  if (!res.ok) throw new ApiError(messageFor(res.error), res.error)
  return { pass: res.pass, event: res.event }
}

/* ------------------------------------------------------------------- staff */

export async function getEventSummaries(eventId?: string): Promise<EventSummary[]> {
  const { data, error } = await supabase.rpc('get_event_summaries', eventId ? { p_event_id: eventId } : {})
  if (error) fail(error)
  return ((data ?? []) as EventSummary[]).map((e) => ({
    ...e,
    registered_count: Number(e.registered_count),
    checked_in_count: Number(e.checked_in_count),
    revoked_count: Number(e.revoked_count),
  }))
}

const EVENT_COLUMNS =
  'id,name,slug,description,location,timezone,starts_at,ends_at,registration_opens_at,registration_closes_at,status,max_attendees,created_at,updated_at,created_by'

export async function getEvent(id: string): Promise<EventRow> {
  const { data, error } = await supabase.from('events').select(EVENT_COLUMNS).eq('id', id).maybeSingle()
  if (error) fail(error)
  if (!data) throw new ApiError('Event not found or you do not have access.', 'event_not_found')
  return data as EventRow
}

export async function createEvent(input: EventInput): Promise<EventRow> {
  const { data, error } = await supabase.from('events').insert(input).select(EVENT_COLUMNS).single()
  if (error) fail(error)
  return data as EventRow
}

export async function updateEvent(id: string, input: Partial<EventInput>): Promise<EventRow> {
  const { data, error } = await supabase
    .from('events')
    .update(input)
    .eq('id', id)
    .select(EVENT_COLUMNS)
    .single()
  if (error) fail(error)
  return data as EventRow
}

export async function deleteEvent(id: string): Promise<void> {
  const { error } = await supabase.from('events').delete().eq('id', id)
  if (error) {
    if ((error as { code?: string }).code === '23503')
      throw new ApiError(
        'Events with registrations cannot be deleted. Archive the event instead.',
        'has_registrations',
      )
    fail(error)
  }
}

export const REGISTRATION_COLUMNS =
  'id,event_id,first_name,last_name,email,status,registered_at,checked_in_at,checked_in_by,revoked_at,token_issued_at,token_version'

export interface RegistrationQuery {
  eventId: string
  search?: string
  status?: RegistrationStatus | 'all'
  page?: number
  pageSize?: number
}

/** Remove characters with special meaning in PostgREST filters or LIKE patterns. */
export function sanitizeSearchTerm(value: string): string {
  return value.replace(/[%_\\"(),:*]/g, '')
}

export async function listRegistrations(
  q: RegistrationQuery,
): Promise<{ rows: Registration[]; total: number }> {
  const pageSize = q.pageSize ?? 50
  const page = q.page ?? 0
  let query = supabase
    .from('registrations')
    .select(REGISTRATION_COLUMNS, { count: 'exact' })
    .eq('event_id', q.eventId)
    .order('registered_at', { ascending: false })
    .order('id', { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1)
  if (q.status && q.status !== 'all') query = query.eq('status', q.status)
  const terms = (q.search ?? '').split(/\s+/).map(sanitizeSearchTerm).filter(Boolean).slice(0, 4)
  for (const term of terms) {
    const pattern = `"%${term}%"`
    query = query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`)
  }
  const { data, error, count } = await query
  if (error) fail(error)
  return { rows: (data ?? []) as Registration[], total: count ?? 0 }
}

/** All registrations for CSV export, fetched in pages. */
export async function listAllRegistrations(eventId: string): Promise<Registration[]> {
  const all: Registration[] = []
  const pageSize = 1000
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('registrations')
      .select(REGISTRATION_COLUMNS)
      .eq('event_id', eventId)
      .order('registered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)
    if (error) fail(error)
    all.push(...((data ?? []) as Registration[]))
    if (!data || data.length < pageSize) break
  }
  return all
}

export async function revokeRegistration(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_registration', { p_registration_id: id })
  if (error) fail(error)
}

export async function restoreRegistration(id: string): Promise<void> {
  const { error } = await supabase.rpc('restore_registration', { p_registration_id: id })
  if (error) fail(error)
}

export async function reissuePass(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('reissue_pass', { p_registration_id: id })
  if (error) fail(error)
  return (data as { token: string }).token
}

export async function listEventStaff(eventId: string): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc('list_event_staff', { p_event_id: eventId })
  if (error) fail(error)
  return (data ?? []) as StaffMember[]
}

export async function addEventStaff(eventId: string, email: string, role: StaffRole): Promise<void> {
  const { error } = await supabase.rpc('add_event_staff', {
    p_event_id: eventId,
    p_email: email,
    p_role: role,
  })
  if (error) fail(error)
}

export async function removeEventStaff(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_event_staff', { p_staff_id: staffId })
  if (error) fail(error)
}

export async function listAdmissionLogs(eventId: string, limit = 50): Promise<AdmissionLog[]> {
  const { data, error } = await supabase
    .from('admission_logs')
    .select('id,registration_id,event_id,operator_id,attempted_at,result,details')
    .eq('event_id', eventId)
    .order('attempted_at', { ascending: false })
    .limit(limit)
  if (error) fail(error)
  return (data ?? []) as AdmissionLog[]
}

/** Names for a set of registration ids (for the activity log). */
export async function registrationNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const { data, error } = await supabase.from('registrations').select('id,first_name,last_name').in('id', ids)
  if (error) fail(error)
  for (const r of (data ?? []) as { id: string; first_name: string; last_name: string }[]) {
    map.set(r.id, `${r.first_name} ${r.last_name}`)
  }
  return map
}

export async function listProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,display_name,is_admin,created_at')
    .order('email', { ascending: true })
  if (error) fail(error)
  return (data ?? []) as Profile[]
}

export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_user_admin', { p_user_id: userId, p_is_admin: isAdmin })
  if (error) fail(error)
}

export interface ClientIpDiagnosis {
  source: 'cf-connecting-ip' | 'x-real-ip' | 'x-forwarded-for(last)' | 'none'
  cf_connecting_ip_present?: boolean
}

/** Admin-only: which request header the rate limiter uses as the client IP. */
export async function diagnoseClientIp(): Promise<ClientIpDiagnosis> {
  const { data, error } = await supabase.rpc('diagnose_client_ip')
  if (error) fail(error)
  return data as ClientIpDiagnosis
}

/* ---------------------------------------------------------------- scanning */

export type AdmitOutcome =
  | { kind: 'response'; response: AdmissionResponse }
  | { kind: 'denied'; message: string }
  | { kind: 'error'; message: string }

/**
 * Submit a credential for server-side validation. Never throws: network and
 * server failures are reported as { kind: 'error' } so the UI can show the
 * amber retry state. Only a server response can produce an admission.
 */
export async function admitPass(eventId: string, token: string, timeoutMs = 10_000): Promise<AdmitOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { data, error } = await supabase
      .rpc('admit_pass', { p_event_id: eventId, p_token: token })
      .abortSignal(controller.signal)
    if (error) {
      const code = errorCode(error)
      if (code === 'not_authorized' || code === 'not_authenticated' || code === 'event_archived') {
        return { kind: 'denied', message: messageFor(code) }
      }
      return { kind: 'error', message: describeError(error) }
    }
    const response = data as AdmissionResponse | null
    if (!response || typeof response.result !== 'string') {
      return { kind: 'error', message: 'Unexpected server response.' }
    }
    return { kind: 'response', response }
  } catch (e) {
    return {
      kind: 'error',
      message: controller.signal.aborted ? 'The server did not respond in time.' : describeError(e),
    }
  } finally {
    clearTimeout(timer)
  }
}
