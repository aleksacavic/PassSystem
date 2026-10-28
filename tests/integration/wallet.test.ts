import { beforeAll, describe, expect, it } from 'vitest'
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { anonClient, createEvent, createStaff, db, env, register, type StaffUser } from './helpers'

// Written by scripts/gen-test-wallet-env.mjs together with supabase/functions/.env.
const PUBLIC_KEY_FILE = 'tests/.artifacts/wallet-test-public.pem'
const configured = existsSync(PUBLIC_KEY_FILE)

async function walletLink(token: string) {
  const res = await fetch(`${env.apiUrl}/functions/v1/google-wallet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey },
    body: JSON.stringify({ token }),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

let admin: StaffUser

beforeAll(async () => {
  admin = await createStaff({ admin: true, label: 'wallet-admin' })
})

describe('wallet_pass_data RPC', () => {
  it('is callable only by the service role', async () => {
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug)
    expect((await anonClient().rpc('wallet_pass_data', { p_token: r.token })).error?.code).toBe('42501')
    expect((await admin.client.rpc('wallet_pass_data', { p_token: r.token })).error?.code).toBe('42501')
  })
})

describe.skipIf(!configured)('google-wallet Edge Function (test issuer + throwaway key)', () => {
  it('returns a signed save link whose QR is the pass URL', async () => {
    const ev = await createEvent(admin.client, { name: 'Wallet Gala', location: 'Town Hall' })
    const r = await register(ev.slug, 'Ana', 'Wallet')
    const res = await walletLink(r.token.toLowerCase().match(/.{4}/g)!.join('-')) // formatted code also works
    expect(res.status).toBe(200)
    const url = res.body!.url as string
    expect(url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true)
    const [h, p, s] = url.split('/').pop()!.split('.')
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      createPublicKey(readFileSync(PUBLIC_KEY_FILE, 'utf8')),
      Buffer.from(s!, 'base64url'),
    )
    expect(ok).toBe(true)
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'))
    const obj = claims.payload.eventTicketObjects[0]
    expect(obj.barcode.value).toBe(`http://127.0.0.1:4173/pass#${r.token}`)
    expect(obj.ticketHolderName).toBe('Ana Wallet')
    expect(claims.payload.eventTicketClasses[0].eventName.defaultValue.value).toBe('Wallet Gala')
    expect(claims.origins).toEqual(['http://127.0.0.1:4173'])
    // Nothing in the link exposes the email or other attendees.
    expect(JSON.stringify(claims)).not.toMatch(/@passsystem\.test|email/)
  })

  it('refuses unknown and revoked passes', async () => {
    expect((await walletLink('ZZZZZZZZZZZZZZZZZZZZZZZZ')).status).toBe(404)
    expect((await walletLink('not a token')).status).toBe(404)
    const ev = await createEvent(admin.client)
    const r = await register(ev.slug)
    const [{ id }] = await db<{ id: string }>(
      `select id from registrations where pass_token_hash = extensions.digest($1,'sha256')`,
      [r.token],
    )
    await admin.client.rpc('revoke_registration', { p_registration_id: id })
    const res = await walletLink(r.token)
    expect(res.status).toBe(410)
    expect(res.body?.url).toBeUndefined()
  })

  it('rejects malformed requests', async () => {
    const res = await fetch(`${env.apiUrl}/functions/v1/google-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})
