#!/usr/bin/env node
/**
 * Fails if the production bundle in dist/ contains anything that looks like a
 * privileged Supabase credential (secret key, service-role JWT, DB password).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? 'dist'
const forbidden = [
  { name: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"'`]+:[^\s"'`]+@/ },
  { name: 'service_role reference', re: /service_role/ },
]
for (const envName of [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SERVICE_ROLE_KEY',
  'SECRET_KEY',
  'JWT_SECRET',
]) {
  const v = process.env[envName]
  if (v && v.length >= 16)
    forbidden.push({ name: `value of $${envName}`, re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
}

// Decode JWT-looking strings and reject any with a privileged role.
const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(js|css|html|json|map|txt)$/.test(entry)) yield p
  }
}

let problems = 0
let files = 0
for (const file of walk(root)) {
  files++
  const text = readFileSync(file, 'utf8')
  for (const f of forbidden) {
    if (f.re.test(text)) {
      console.error(`✗ ${file}: contains ${f.name}`)
      problems++
    }
  }
  for (const m of text.matchAll(jwtRe)) {
    try {
      const payload = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString('utf8'))
      if (payload.role && payload.role !== 'anon') {
        console.error(`✗ ${file}: contains a JWT with role "${payload.role}"`)
        problems++
      }
    } catch {
      /* not a JWT */
    }
  }
}

if (problems) {
  console.error(`Found ${problems} potential secret(s) in ${root}/.`)
  process.exit(1)
}
console.log(`✓ No privileged secrets found in ${files} files under ${root}/.`)
