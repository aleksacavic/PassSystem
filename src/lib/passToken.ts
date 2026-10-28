import { siteOrigin } from './env'

/** Crockford base32 alphabet used by the server-side token generator. */
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{24}$/

/**
 * Canonical token form, mirroring private.normalize_pass_token() in SQL:
 * uppercase, spaces/dashes removed, O->0 and I/L->1. Returns null if invalid.
 */
export function normalizePassToken(input: string): string | null {
  if (input.length > 200) return null
  const t = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  return TOKEN_RE.test(t) ? t : null
}

/** Human-friendly grouping: ABCD-EFGH-... */
export function formatPassToken(token: string): string {
  return token.match(/.{1,4}/g)?.join('-') ?? token
}

export function passUrl(token: string): string {
  return `${siteOrigin()}/pass#${token}`
}

export function registrationUrl(slug: string): string {
  return `${siteOrigin()}/e/${encodeURIComponent(slug)}`
}

/**
 * Extract a pass token from scanned QR content or manual input. Accepts a pass
 * URL (…/pass#TOKEN, legacy …/p/TOKEN, ?t=TOKEN) or a bare token in any format.
 * Returns null when the content cannot contain a pass token.
 */
export function extractPassToken(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const candidates = [
        url.hash.replace(/^#/, ''),
        url.searchParams.get('t') ?? '',
        url.pathname.match(/\/p(?:ass)?\/([^/]+)\/?$/)?.[1] ?? '',
      ]
      for (const c of candidates) {
        const token = c ? normalizePassToken(decodeURIComponent(c)) : null
        if (token) return token
      }
    } catch {
      return null
    }
    return null
  }
  return normalizePassToken(text)
}
