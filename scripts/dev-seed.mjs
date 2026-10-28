#!/usr/bin/env node
/**
 * Local development seed: creates demo staff accounts on the LOCAL Supabase
 * stack (supabase start). Refuses to run against non-local URLs.
 *
 *   npm run db:seed:dev
 */
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const status = Object.fromEntries(
  execSync('npx supabase status -o env', { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
)
const url = status.API_URL
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error('Local Supabase is not running (or not local). Run `npm run db:start` first.')
  process.exit(1)
}
const admin = createClient(url, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const users = [
  { email: 'admin@passsystem.test', password: 'AdminPass123', admin: true },
  { email: 'organizer@passsystem.test', password: 'OrganizerPass123', admin: false },
  { email: 'operator@passsystem.test', password: 'OperatorPass123', admin: false },
]

for (const u of users) {
  const { data, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true,
  })
  let id = data?.user?.id
  if (error) {
    if (!/already/i.test(error.message)) throw error
    const { data: list } = await admin.auth.admin.listUsers()
    id = list.users.find((x) => x.email === u.email)?.id
  }
  if (u.admin) await admin.from('profiles').update({ is_admin: true }).eq('id', id)
  console.log(`${u.admin ? 'admin   ' : 'staff   '} ${u.email} / ${u.password}`)
}
console.log('\nSign in at http://localhost:5173/login')
