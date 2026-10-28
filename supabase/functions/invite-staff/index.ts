// Supabase Edge Function: invite a staff member by email (administrators only).
//
// The browser never holds the secret key. This function runs on Supabase's
// servers, checks that the caller is a signed-in PassSystem administrator,
// then uses the service-role key (provided to Edge Functions by Supabase) to
// send a Supabase Auth invite. The invited person sets their own password from
// the email link. Optionally marks the invite as an administrator invite;
// rights are applied when the invite is accepted.
//
// Request:  POST { "email": string, "admin"?: boolean, "redirectTo"?: string }
// Response: 200 { ok: true, user_id, email, admin }
//           4xx { ok: false, error: <code>, message }
//
// No third-party imports: the function talks to Supabase Auth and PostgREST
// over HTTP, so it has nothing to download when it boots.
import { getCaller, isAdmin, serviceHeaders, type Supa } from '../_shared/adminAuth.ts'

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

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

  // Who is calling, and are they an administrator?
  const caller = await getCaller(supa, jwt)
  if (!caller) return fail(401, 'not_authenticated', 'Please sign in again.')
  if (!(await isAdmin(supa, caller.id)))
    return fail(403, 'admin_required', 'Only administrators can invite staff.')

  let body: { email?: unknown; admin?: unknown; redirectTo?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_input', 'Invalid request body.')
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return fail(400, 'invalid_email', 'Enter a valid email address.')
  }
  const makeAdmin = body.admin === true
  // Only http(s) URLs; Supabase Auth additionally enforces its redirect allow list.
  let redirectTo: string | undefined
  if (typeof body.redirectTo === 'string') {
    try {
      const u = new URL(body.redirectTo)
      if (u.protocol === 'https:' || u.protocol === 'http:') redirectTo = u.toString()
    } catch {
      /* ignore invalid redirect */
    }
  }

  const inviteUrl = new URL(`${url}/auth/v1/invite`)
  if (redirectTo) inviteUrl.searchParams.set('redirect_to', redirectTo)
  const inviteRes = await fetch(inviteUrl, {
    method: 'POST',
    headers: serviceHeaders(supa),
    body: JSON.stringify({ email, data: { invited_by: caller.id } }),
  })
  const invited = (await inviteRes.json().catch(() => ({}))) as {
    id?: string
    code?: number
    error_code?: string
    msg?: string
    message?: string
  }
  if (!inviteRes.ok || !invited.id) {
    const msg = `${invited.error_code ?? ''} ${invited.msg ?? invited.message ?? ''}`
    if (
      inviteRes.status === 422 &&
      /email_exists|already been registered|already registered|exists/i.test(msg)
    ) {
      return fail(
        409,
        'user_exists',
        'This person already has an account. They can use "Forgot password" to sign in.',
      )
    }
    if (inviteRes.status === 429 || /rate limit/i.test(msg)) {
      return fail(429, 'email_rate_limited', 'Too many invite emails were sent recently. Try again later.')
    }
    console.error('invite failed', inviteRes.status, msg)
    return fail(502, 'invite_failed', 'The invite email could not be sent. Try again later.')
  }
  const invitedId = invited.id

  if (makeAdmin) {
    // Granted by a database trigger only once the invite is accepted (email
    // confirmed), so a mistyped address never becomes an administrator.
    // app_metadata can only be written with the service role.
    const flagRes = await fetch(`${url}/auth/v1/admin/users/${invitedId}`, {
      method: 'PUT',
      headers: serviceHeaders(supa),
      body: JSON.stringify({ app_metadata: { pending_admin: true } }),
    })
    if (!flagRes.ok) {
      console.error('pending admin flag failed', flagRes.status)
      return reply(200, {
        ok: true,
        user_id: invitedId,
        email,
        admin: false,
        warning:
          'Invite sent, but administrator rights could not be prepared. Use "Make admin" after they accept.',
      })
    }
  }

  return reply(200, { ok: true, user_id: invitedId, email, admin: makeAdmin })
})
