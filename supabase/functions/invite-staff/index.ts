// Supabase Edge Function: invite a staff member by email (administrators only).
//
// The browser never holds the secret key. This function runs on Supabase's
// servers, checks that the caller is a signed-in PassSystem administrator,
// then uses the service-role key (provided to Edge Functions by Supabase) to
// send a Supabase Auth invite. The invited person sets their own password from
// the email link. Optionally grants administrator rights.
//
// Request:  POST { "email": string, "admin"?: boolean, "redirectTo"?: string }
// Response: 200 { ok: true, user_id, email, admin }
//           4xx { ok: false, error: <code>, message }
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'

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

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  // Who is calling, and are they an administrator?
  const { data: caller, error: callerError } = await admin.auth.getUser(jwt)
  if (callerError || !caller.user) return fail(401, 'not_authenticated', 'Please sign in again.')
  const { data: profile } = await admin
    .from('profiles')
    .select('is_admin')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!profile?.is_admin) return fail(403, 'admin_required', 'Only administrators can invite staff.')

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

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { invited_by: caller.user.id },
  })
  if (inviteError || !invited.user) {
    const msg = inviteError?.message ?? ''
    if (/already been registered|already registered|exists/i.test(msg)) {
      return fail(
        409,
        'user_exists',
        'This person already has an account. They can use "Forgot password" to sign in.',
      )
    }
    if (/rate limit/i.test(msg)) {
      return fail(429, 'email_rate_limited', 'Too many invite emails were sent recently. Try again later.')
    }
    console.error('invite failed', inviteError?.status, msg)
    return fail(502, 'invite_failed', 'The invite email could not be sent. Try again later.')
  }

  if (makeAdmin) {
    // The profile row is created by the on_auth_user_created trigger during the invite.
    const { error: adminError } = await admin
      .from('profiles')
      .update({ is_admin: true })
      .eq('id', invited.user.id)
    if (adminError) {
      console.error('grant admin failed', adminError.message)
      return reply(200, {
        ok: true,
        user_id: invited.user.id,
        email,
        admin: false,
        warning: 'Invite sent, but administrator rights could not be granted. Use "Make admin" in the list.',
      })
    }
  }

  return reply(200, { ok: true, user_id: invited.user.id, email, admin: makeAdmin })
})
