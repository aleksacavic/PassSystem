/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_PUBLIC_SITE_URL?: string
  /** "1" once the google-wallet Edge Function and its secrets are set up. */
  readonly VITE_GOOGLE_WALLET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
