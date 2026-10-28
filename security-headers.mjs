/**
 * Security headers for the static frontend. Used by `vite preview` (so the E2E
 * suite runs under the production CSP) and mirrored in vercel.json / netlify.toml.
 *
 * supabaseOrigin: the project's API origin. Hosted Supabase projects match
 * https://*.supabase.co; use your custom API domain if you configured one.
 */
export function securityHeaders(supabaseOrigin = 'https://*.supabase.co') {
  const ws = supabaseOrigin.replace(/^http/, 'ws')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self' ${supabaseOrigin} ${ws}`,
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
