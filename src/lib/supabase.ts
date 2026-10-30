import { createClient } from '@supabase/supabase-js'
import { env } from './env'

// The publishable (anon) key is designed to be public. All authorization is
// enforced by Postgres RLS policies and SECURITY DEFINER functions.
export const supabase = createClient(
  env.supabaseUrl || 'http://invalid.local',
  env.supabaseKey || 'missing',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  },
)
