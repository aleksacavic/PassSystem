// Supabase Edge Function: remove a staff account (administrators only).
//
// Deletes the person's Supabase Auth account with the service-role key. Their
// profile and event assignments are removed with it (foreign keys cascade), so
// they lose access to every event and can no longer sign in. Registrations and
// admission logs are kept; the "checked in by" / operator references become
// empty. Works for pending invites too (cancels the invite). Their sessions
// can no longer be refreshed; a browser that is still open keeps its access
// token until it expires (at most an hour) but no longer sees any event.
// Administrators must have their rights removed first, and nobody can remove
// their own account.
//
// Request:  POST { "userId": string }
// Response: 200 { ok: true, user_id, email }
//           4xx { ok: false, error: <code>, message }
import { getCaller, getProfile, isAdmin, serviceHeaders, type Supa } from '../_shared/adminAuth.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

const fail = (status: number, error: string, message: string) => reply(status, { ok: false, error, message })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey)
    return fail(500, 'misconfigured', 'Function is missing its Supabase configuration.')

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return fail(401, 'not_authenticated', 'Please sign in again.')

  const supa: Supa = { url, serviceKey }

  const caller = await getCaller(supa, jwt)
  if (!caller) return fail(401, 'not_authenticated', 'Please sign in again.')
  if (!(await isAdmin(supa, caller.id)))
    return fail(403, 'admin_required', 'Only administrators can remove staff.')

  let body: { userId?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_input', 'Invalid request body.')
  }
  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  if (!UUID_RE.test(userId)) return fail(400, 'invalid_input', 'Unknown account.')
  if (userId === caller.id) return fail(400, 'self_removal', 'You cannot remove your own account.')

  const target = await getProfile(supa, userId)
  if (!target) return fail(404, 'user_not_found', 'This account no longer exists.')
  if (target.is_admin) {
    return fail(409, 'remove_admin_first', 'Remove administrator rights first, then remove the account.')
  }

  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(supa),
  })
  if (res.status === 404) return fail(404, 'user_not_found', 'This account no longer exists.')
  if (!res.ok) {
    console.error('delete user failed', res.status)
    return fail(502, 'remove_failed', 'The account could not be removed. Try again later.')
  }
  return reply(200, { ok: true, user_id: userId, email: target.email })
})
