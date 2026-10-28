// Supabase Edge Function: "Add to Google Wallet" link for a pass (public).
//
// The attendee's browser sends the raw pass token (their credential). The
// function looks the pass up with the service role, then returns a signed
// save-to-wallet URL. Nothing is returned for unknown or revoked passes.
// Secrets (Supabase → Edge Functions → Secrets):
//   GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
//   GOOGLE_WALLET_PRIVATE_KEY, PUBLIC_SITE_URL, optional GOOGLE_WALLET_ISSUER_NAME
//
// Request:  POST { "token": string }
// Response: 200 { ok: true, url } | 4xx/5xx { ok: false, error, message }
//
// No third-party imports: nothing to download when the function boots.
import { buildSaveUrl, type WalletPassData } from '../_shared/googleWallet.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const fail = (status: number, error: string, message: string) => reply(status, { ok: false, error, message })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const issuerId = Deno.env.get('GOOGLE_WALLET_ISSUER_ID')
  const serviceAccountEmail = Deno.env.get('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL')
  const privateKeyPem = Deno.env.get('GOOGLE_WALLET_PRIVATE_KEY')
  const siteOrigin = Deno.env.get('PUBLIC_SITE_URL')
  if (!url || !serviceKey)
    return fail(500, 'misconfigured', 'Function is missing its Supabase configuration.')
  if (!issuerId || !serviceAccountEmail || !privateKeyPem || !siteOrigin) {
    return fail(503, 'wallet_not_configured', 'Google Wallet is not set up yet.')
  }

  let token = ''
  try {
    const body = (await req.json()) as { token?: unknown }
    token = typeof body.token === 'string' ? body.token.slice(0, 200) : ''
  } catch {
    return fail(400, 'invalid_input', 'Invalid request body.')
  }
  if (!token) return fail(400, 'invalid_input', 'Missing pass.')

  const res = await fetch(`${url}/rest/v1/rpc/wallet_pass_data`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_token: token }),
  })
  if (!res.ok) {
    console.error('wallet_pass_data failed', res.status)
    return fail(502, 'lookup_failed', 'Could not load the pass. Try again.')
  }
  const data = (await res.json()) as ({ ok: true } & WalletPassData) | { ok: false; error: string }
  if (!data.ok) {
    return data.error === 'pass_revoked'
      ? fail(410, 'pass_revoked', 'This pass has been revoked.')
      : fail(404, 'pass_not_found', 'This pass could not be found.')
  }

  try {
    const saveUrl = await buildSaveUrl(
      {
        issuerId,
        serviceAccountEmail,
        privateKeyPem,
        issuerName: Deno.env.get('GOOGLE_WALLET_ISSUER_NAME') || 'PassSystem',
        siteOrigin: siteOrigin.replace(/\/+$/, ''),
      },
      data,
    )
    return reply(200, { ok: true, url: saveUrl })
  } catch (e) {
    console.error('wallet signing failed', (e as Error).message)
    return fail(500, 'signing_failed', 'Google Wallet is misconfigured (signing key).')
  }
})
