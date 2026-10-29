// Supabase Edge Function: invite a staff member by email (administrators only).
//
// The browser never holds the secret key. This function runs on Supabase's
// servers, checks that the caller is a signed-in PassSystem administrator,
// then uses the service-role key (provided to Edge Functions by Supabase) to
// send a Supabase Auth invite. The invited person sets their own password from
// the email link. Optionally marks the invite as an administrator invite;
// rights are applied when the invite is accepted.
//
// With "delivery": "link" no email is sent: the function returns a one-time
// link to the site's /invite page instead, for the administrator to share
// (WhatsApp, SMS…). Also works again for an invite that is still pending.
// The token sits in the URL fragment and is only redeemed when the person
// presses "Accept", so link previews in chat apps cannot use it up.
//
// Request:  POST { "email": string, "admin"?: boolean, "redirectTo"?: string, "delivery"?: "email" | "link" }
// Response: 200 { ok: true, user_id, email, admin, link? }
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

  let body: { email?: unknown; admin?: unknown; redirectTo?: unknown; delivery?: unknown }
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

  const byLink = body.delivery === 'link'
  if (byLink && !redirectTo) return fail(400, 'invalid_input', 'Missing site address for the invite link.')

  // Reserve the address for this invite before Auth issues its link: one invite
  // at a time per address (an older request reaching Auth later would replace
  // the token of the link a newer one already returned). The role is saved
  // against this generation, which a demotion meanwhile makes stale.
  const genRes = await fetch(`${url}/rest/v1/rpc/begin_invite`, {
    method: 'POST',
    headers: serviceHeaders(supa),
    body: JSON.stringify({ p_email: email }),
  })
  const generation = genRes.ok ? ((await genRes.json().catch(() => undefined)) as unknown) : undefined
  if (generation === null) {
    return fail(
      409,
      'invite_in_progress',
      'An invite for this person is being sent right now. Try again in a minute.',
    )
  }
  if (typeof generation !== 'number') {
    console.error('reserving the invite failed', genRes.status)
    return fail(502, 'invite_failed', 'The invite could not be created. Try again later.')
  }

  try {
    let inviteRes: Response
    if (byLink) {
      inviteRes = await fetch(`${url}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: serviceHeaders(supa),
        body: JSON.stringify({
          type: 'invite',
          email,
          data: { invited_by: caller.id },
          redirect_to: redirectTo,
        }),
      })
    } else {
      const inviteUrl = new URL(`${url}/auth/v1/invite`)
      if (redirectTo) inviteUrl.searchParams.set('redirect_to', redirectTo)
      inviteRes = await fetch(inviteUrl, {
        method: 'POST',
        headers: serviceHeaders(supa),
        body: JSON.stringify({ email, data: { invited_by: caller.id } }),
      })
    }
    const raw = (await inviteRes.json().catch(() => ({}))) as {
      id?: string
      user?: { id?: string }
      hashed_token?: string
      properties?: { hashed_token?: string }
      code?: number
      error_code?: string
      msg?: string
      message?: string
    }
    const invited = { ...raw, id: raw.id ?? raw.user?.id }
    const hashedToken = raw.hashed_token ?? raw.properties?.hashed_token
    if (!inviteRes.ok || !invited.id || (byLink && !hashedToken)) {
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
    const link = byLink
      ? `${new URL(redirectTo!).origin}/invite#token=${encodeURIComponent(hashedToken!)}`
      : undefined

    // The latest invite decides the role of a pending account. Administrator
    // rights are granted once, by a database trigger, when the invite is accepted
    // (email confirmed), so a mistyped address never becomes an administrator.
    const roleRes = await fetch(`${url}/rest/v1/rpc/set_pending_admin`, {
      method: 'POST',
      headers: serviceHeaders(supa),
      body: JSON.stringify({
        p_user_id: invitedId,
        p_admin: makeAdmin,
        p_generation: generation,
        p_invited_by: caller.id,
      }),
    })
    const outcome = roleRes.ok ? ((await roleRes.json().catch(() => null)) as string | null) : null
    if (outcome === 'stale') {
      // This person's rights changed while the invite was being sent (or this
      // request outlived its reservation). Its link is not handed out.
      return fail(
        409,
        'invite_superseded',
        "This person's rights changed while the invite was being sent. Check the staff list before inviting again.",
      )
    }
    if (!outcome || outcome === 'not_found') {
      console.error('setting the invite role failed', roleRes.status, outcome)
      return reply(200, {
        ok: true,
        user_id: invitedId,
        email,
        admin: false,
        link,
        warning: makeAdmin
          ? 'Invite created, but administrator rights could not be prepared. Use "Make admin" after they accept.'
          : 'Invite created, but its role could not be saved. Check the staff list before they accept.',
      })
    }
    // What the account will actually be once the invite is accepted.
    const admin = outcome === 'queued' || outcome === 'granted'
    return reply(200, { ok: true, user_id: invitedId, email, admin, link })
  } finally {
    // Normally already released by set_pending_admin; this covers the failures.
    await fetch(`${url}/rest/v1/rpc/end_invite`, {
      method: 'POST',
      headers: serviceHeaders(supa),
      body: JSON.stringify({ p_email: email, p_generation: generation }),
    }).catch(() => undefined)
  }
})
