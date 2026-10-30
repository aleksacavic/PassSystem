/**
 * Security headers for the static frontend. Used by `vite preview` (so the E2E
 * suite runs under the production CSP) and mirrored in vercel.json / netlify.toml.
 *
 * supabaseOrigin: the project's exact API origin (https://<ref>.supabase.co or
 * a custom API domain). Pinning it means injected script could not send data
 * to some other Supabase project. Realtime is not used, so no wss: source.
 */
export const PRODUCTION_SUPABASE_ORIGIN = 'https://wvwpedmwhsddsfixjpjd.supabase.co'

export function securityHeaders(supabaseOrigin = PRODUCTION_SUPABASE_ORIGIN) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self' ${supabaseOrigin}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
}
