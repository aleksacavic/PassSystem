const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  ''

export const env = {
  supabaseUrl,
  supabaseKey,
  configured: Boolean(supabaseUrl && supabaseKey),
}

/** Public origin used to build shareable links. Configurable, never hardcoded. */
export function siteOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_SITE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return window.location.origin
}
