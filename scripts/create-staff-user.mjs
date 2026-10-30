#!/usr/bin/env node
/**
 * Create (or update) a PassSystem staff account using the Supabase Admin API.
 *
 * Run this on a trusted machine only. It needs the project's SECRET / service-role
 * key, which must never be put in a VITE_* variable or shipped to browsers.
 *
 *   SUPABASE_URL=https://xyz.supabase.co \
 *   SUPABASE_SECRET_KEY=sb_secret_... \
 *   node scripts/create-staff-user.mjs --email owner@example.org [--admin] [--password '...'] [--name 'Jane Doe']
 *
 * Without --password a random password is generated and printed once; the
 * person can change it under Account after signing in (or use "Forgot password").
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
    admin: { type: 'boolean', default: false },
  },
})

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key || !values.email) {
  console.error(
    'Usage: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/create-staff-user.mjs --email you@example.org [--admin]',
  )
  process.exit(1)
}

const email = values.email.trim().toLowerCase()
const generated = !values.password
const password = values.password ?? `${randomBytes(12).toString('base64url')}7a`

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

async function findUser(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit
    if (data.users.length < 200) return null
  }
  return null
}

let user = await findUser(email)
if (user) {
  console.log(`User ${email} already exists (${user.id}).`)
  if (values.password) {
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password })
    if (error) throw error
    console.log('Password updated.')
  }
} else {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: values.name ? { display_name: values.name } : {},
  })
  if (error) {
    console.error(`Could not create user: ${error.message}`)
    process.exit(1)
  }
  user = data.user
  console.log(`Created ${email} (${user.id}).`)
  if (generated) console.log(`Temporary password (shown once): ${password}`)
}

if (values.admin) {
  const { error } = await supabase.from('profiles').update({ is_admin: true }).eq('id', user.id)
  if (error) {
    console.error(`Could not grant administrator: ${error.message}`)
    process.exit(1)
  }
  console.log('Administrator rights granted.')
}
