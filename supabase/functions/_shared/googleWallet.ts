// Google Wallet "Save to Google Wallet" links for PassSystem event tickets.
//
// Pure module (Web Crypto only), shared by the Edge Function and the Node test
// suite. The link carries a JWT signed with the issuer's service-account key
// that defines the event ticket class (one per event) and the ticket object
// (one per pass). Google creates or updates them when the attendee saves.
// Docs: https://developers.google.com/wallet/tickets/events

export interface WalletConfig {
  issuerId: string
  serviceAccountEmail: string
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") from the service-account JSON key. */
  privateKeyPem: string
  issuerName: string
  /** Public site origin, e.g. https://passsystem-phi.vercel.app */
  siteOrigin: string
}

export interface WalletPassData {
  token: string
  registration: { id: string; first_name: string; last_name: string; token_version: number }
  event: {
    id: string
    name: string
    location: string | null
    starts_at: string
    ends_at: string | null
  }
}

const ID_SAFE = /[^A-Za-z0-9._-]/g

/** Class id: one per event. Object id: one per pass *version*, so a reissued pass gets a new wallet ticket. */
export function walletIds(cfg: Pick<WalletConfig, 'issuerId'>, data: WalletPassData) {
  const classId = `${cfg.issuerId}.passsystem-event-${data.event.id}`.replace(ID_SAFE, '_')
  const objectId =
    `${cfg.issuerId}.passsystem-pass-${data.registration.id}-v${data.registration.token_version}`.replace(
      ID_SAFE,
      '_',
    )
  return { classId, objectId }
}

const text = (value: string) => ({ defaultValue: { language: 'en', value } })

export function formatPassCode(token: string): string {
  return token.match(/.{1,4}/g)?.join('-') ?? token
}

/** Claims of the save-to-wallet JWT (unsigned). */
export function buildSaveClaims(
  cfg: WalletConfig,
  data: WalletPassData,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const { classId, objectId } = walletIds(cfg, data)
  const passUrl = `${cfg.siteOrigin.replace(/\/+$/, '')}/pass#${data.token}`
  const eventTicketClass: Record<string, unknown> = {
    id: classId,
    issuerName: cfg.issuerName,
    reviewStatus: 'UNDER_REVIEW',
    eventName: text(data.event.name),
    dateTime: { start: data.event.starts_at, ...(data.event.ends_at ? { end: data.event.ends_at } : {}) },
  }
  if (data.event.location) {
    eventTicketClass.venue = { name: text(data.event.location), address: text(data.event.location) }
  }
  const eventTicketObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    ticketHolderName: `${data.registration.first_name} ${data.registration.last_name}`,
    barcode: {
      // Same content as the on-screen QR, so door scanners need no changes.
      type: 'QR_CODE',
      value: passUrl,
      alternateText: formatPassCode(data.token),
    },
    linksModuleData: { uris: [{ uri: passUrl, description: 'Open pass', id: 'pass' }] },
  }
  return {
    iss: cfg.serviceAccountEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: nowSeconds,
    origins: [cfg.siteOrigin],
    payload: { eventTicketClasses: [eventTicketClass], eventTicketObjects: [eventTicketObject] },
  }
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** Accepts the PEM with real or JSON-escaped ("\n") line breaks, as pasted from the key file. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  if (!body) throw new Error('Empty private key')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

export async function signJwtRs256(claims: unknown, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const header = base64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const body = base64url(utf8(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${header}.${body}`))
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`
}

export async function buildSaveUrl(cfg: WalletConfig, data: WalletPassData): Promise<string> {
  const jwt = await signJwtRs256(buildSaveClaims(cfg, data), cfg.privateKeyPem)
  return `https://pay.google.com/gp/v/save/${jwt}`
}
