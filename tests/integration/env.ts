import { execSync } from 'node:child_process'

export interface StackEnv {
  apiUrl: string
  anonKey: string
  serviceKey: string
  dbUrl: string
}

/** Local stack credentials: from env (CI) or `supabase status` (dev machine). */
export function stackEnv(): StackEnv {
  if (
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.SUPABASE_DB_URL
  ) {
    return {
      apiUrl: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      dbUrl: process.env.SUPABASE_DB_URL,
    }
  }
  const out = execSync('npx supabase status -o env', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const kv = Object.fromEntries(
    out
      .split('\n')
      .map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => [m[1], m[2]]),
  )
  const apiUrl = kv.API_URL
  if (!apiUrl || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(apiUrl)) {
    throw new Error('Integration tests need the LOCAL Supabase stack. Run `npm run db:start`.')
  }
  return {
    apiUrl,
    anonKey: kv.PUBLISHABLE_KEY || kv.ANON_KEY!,
    serviceKey: kv.SERVICE_ROLE_KEY!,
    dbUrl: kv.DB_URL!,
  }
}
