// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildSaveClaims,
  buildSaveUrl,
  pemToPkcs8,
  signJwtRs256,
  walletConfigFromEnv,
  walletIds,
  type WalletConfig,
  type WalletPassData,
} from './googleWallet.ts'

async function testKey() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const b64 = Buffer.from(pkcs8)
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  }
}

const data: WalletPassData = {
  token: '87J813AZE9GZXK95NP3GA5F4',
  registration: {
    id: '3f1b6d2e-1111-4222-8333-444455556666',
    first_name: 'Ana',
    last_name: 'Petrović',
    token_version: 2,
  },
  event: {
    id: '9a8b7c6d-aaaa-4bbb-8ccc-dddd0000eeee',
    name: 'Party test',
    location: 'Town Hall',
    starts_at: '2026-11-20T18:00:00Z',
    ends_at: null,
  },
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('Google Wallet save links', () => {
  it('builds a signed JWT that verifies with the public key', async () => {
    const { pem, publicKey } = await testKey()
    const cfg: WalletConfig = {
      issuerId: '3388000000012345678',
      serviceAccountEmail: 'wallet@proj.iam.gserviceaccount.com',
      privateKeyPem: pem,
      issuerName: 'PassSystem',
      siteOrigin: 'https://passsystem-phi.vercel.app',
    }
    const url = await buildSaveUrl(cfg, data)
    expect(url.startsWith('https://pay.google.com/gp/v/save/')).toBe(true)
    const jwt = url.split('/').pop()!
    const [h, p, s] = jwt.split('.')
    expect(decode(h!)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      Buffer.from(s!, 'base64url'),
      new TextEncoder().encode(`${h}.${p}`),
    )
    expect(ok).toBe(true)
    const claims = decode(p!)
    expect(claims).toMatchObject({
      iss: cfg.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      origins: [cfg.siteOrigin],
    })
    const obj = claims.payload.eventTicketObjects[0]
    // The wallet QR is exactly the on-screen QR, so scanners work unchanged.
    expect(obj.barcode).toEqual({
      type: 'QR_CODE',
      value: `https://passsystem-phi.vercel.app/pass#${data.token}`,
      alternateText: '87J8-13AZ-E9GZ-XK95-NP3G-A5F4',
    })
    expect(obj.ticketHolderName).toBe('Ana Petrović')
    expect(obj.classId).toBe(claims.payload.eventTicketClasses[0].id)
    expect(claims.payload.eventTicketClasses[0]).toMatchObject({
      issuerName: 'PassSystem',
      eventName: { defaultValue: { value: 'Party test' } },
      venue: { name: { defaultValue: { value: 'Town Hall' } } },
    })
    expect(url.length).toBeLessThan(2500)
  })

  it('accepts the key with JSON-escaped line breaks (as pasted from the key file)', async () => {
    const { pem } = await testKey()
    const escaped = pem.replace(/\n/g, '\\n')
    expect(pemToPkcs8(escaped).byteLength).toBe(pemToPkcs8(pem).byteLength)
    await expect(signJwtRs256({ a: 1 }, escaped)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('a reissued pass gets a new wallet object id; ids use only allowed characters', () => {
    const a = walletIds({ issuerId: '123' }, data)
    const b = walletIds(
      { issuerId: '123' },
      { ...data, registration: { ...data.registration, token_version: 3 } },
    )
    expect(a.classId).toBe(b.classId)
    expect(a.objectId).not.toBe(b.objectId)
    for (const id of [a.classId, a.objectId]) expect(id).toMatch(/^123\.[A-Za-z0-9._-]+$/)
  })

  it('omits venue when the event has no location', () => {
    const claims = buildSaveClaims(
      {
        issuerId: '1',
        serviceAccountEmail: 'x',
        privateKeyPem: '',
        issuerName: 'P',
        siteOrigin: 'https://s',
      },
      { ...data, event: { ...data.event, location: null } },
    )
    expect(claims.payload.eventTicketClasses[0]).not.toHaveProperty('venue')
  })

  it('rejects a broken key instead of producing an unsigned link', async () => {
    await expect(signJwtRs256({}, '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----')).rejects.toThrow()
  })
})

describe('walletConfigFromEnv', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name]
  const keyFile = JSON.stringify({
    type: 'service_account',
    client_email: 'wallet@proj.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  })

  it('reads the whole service-account key file and defaults the site and issuer name', () => {
    expect(
      walletConfigFromEnv(
        env({ GOOGLE_WALLET_ISSUER_ID: ' 3388 ', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: keyFile }),
      ),
    ).toEqual({
      issuerId: '3388',
      serviceAccountEmail: 'wallet@proj.iam.gserviceaccount.com',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      issuerName: 'PassSystem',
      siteOrigin: 'https://passsystem-phi.vercel.app',
    })
  })

  it('accepts the key file pasted over several lines, and the separate variables', () => {
    const pretty = JSON.stringify(JSON.parse(keyFile), null, 2)
    expect(
      walletConfigFromEnv(env({ GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: pretty }))
        ?.serviceAccountEmail,
    ).toBe('wallet@proj.iam.gserviceaccount.com')
    expect(
      walletConfigFromEnv(
        env({
          GOOGLE_WALLET_ISSUER_ID: '1',
          GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'a@b.iam.gserviceaccount.com',
          GOOGLE_WALLET_PRIVATE_KEY: 'pem',
          PUBLIC_SITE_URL: 'https://tickets.example.org/',
          GOOGLE_WALLET_ISSUER_NAME: 'Club',
        }),
      ),
    ).toMatchObject({
      serviceAccountEmail: 'a@b.iam.gserviceaccount.com',
      siteOrigin: 'https://tickets.example.org',
      issuerName: 'Club',
    })
  })

  it('is null when something required is missing or the key file is not JSON', () => {
    expect(walletConfigFromEnv(env({}))).toBeNull()
    expect(walletConfigFromEnv(env({ GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: keyFile }))).toBeNull()
    expect(walletConfigFromEnv(env({ GOOGLE_WALLET_ISSUER_ID: '1' }))).toBeNull()
    expect(
      walletConfigFromEnv(
        env({ GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: '{not json' }),
      ),
    ).toBeNull()
  })
})
