// The production security headers, as generated and as deployed to every route (F-15, R4-07, R5-04).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { PRODUCTION_SUPABASE_ORIGIN, securityHeaders } from '../../security-headers.mjs'

const directives = (csp: string) =>
  new Map(
    csp.split(';').map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/)
      return [name!, sources] as const
    }),
  )

const root = resolve(__dirname, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

interface Rule {
  matches: (path: string) => boolean
  /** [field name in lower case (HTTP names are case-insensitive), value] */
  headers: [string, string][]
}

/** Vercel `source` patterns (path-to-regexp): `:name*`, `:name` and raw regex groups. */
function vercelRules(json: string): Rule[] {
  const config = JSON.parse(json) as {
    headers: { source: string; headers: { key: string; value: string }[] }[]
  }
  return config.headers.map((rule) => {
    const pattern = rule.source.replace(/:\w+\*/g, '.*').replace(/:\w+/g, '[^/]+')
    const re = new RegExp(`^${pattern}$`)
    return {
      matches: (path) => re.test(path),
      headers: rule.headers.map((h): [string, string] => [h.key.toLowerCase(), h.value]),
    }
  })
}

/**
 * Netlify `[[headers]]` blocks, read with a TOML parser (quoted keys and
 * literal strings included): a `for` glob and its `values`. A value that is
 * neither a string nor a list of strings fails the test instead of being skipped.
 */
function netlifyRules(toml: string): Rule[] {
  const config = parseToml(toml) as { headers?: { for: string; values?: Record<string, unknown> }[] }
  return (config.headers ?? []).map((block) => {
    const re = new RegExp(`^${block.for.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    const headers = Object.entries(block.values ?? {}).flatMap(([name, value]): [string, string][] => {
      const values = Array.isArray(value) ? value : [value]
      if (!values.every((v) => typeof v === 'string'))
        throw new Error(`unsupported value for ${name} in netlify.toml`)
      return values.map((v): [string, string] => [name.toLowerCase(), v])
    })
    return { matches: (path) => re.test(path), headers }
  })
}

/**
 * Every value each field gets on `path`, from all matching rules. Hosts differ
 * in how they combine a field set twice (override, append), so a security
 * field must not be set to anything but the expected value on any route.
 */
function effective(rules: Rule[], path: string) {
  const fields = new Map<string, string[]>()
  for (const rule of rules.filter((r) => r.matches(path)))
    for (const [name, value] of rule.headers) fields.set(name, [...(fields.get(name) ?? []), value])
  return fields
}

// Guest, staff and scanner routes, and the static files they load.
const PATHS = [
  '/',
  '/e/autumn-gala',
  '/pass',
  '/login',
  '/invite',
  '/admin',
  '/admin/events/0b6f3f7e-1a2b-4c3d-9e8f-001122334455',
  '/scan/0b6f3f7e-1a2b-4c3d-9e8f-001122334455',
  '/index.html',
  '/assets/index-abc123.js',
  '/favicon.svg',
]

function missingOrDifferent(rules: Rule[]) {
  const expected = securityHeaders()
  const problems: string[] = []
  for (const path of PATHS) {
    const got = effective(rules, path)
    for (const [key, value] of Object.entries(expected)) {
      const values = got.get(key.toLowerCase()) ?? []
      if (values.length === 0 || values.some((v) => v !== value)) problems.push(`${path} ${key}`)
    }
  }
  return problems
}

describe('production security headers', () => {
  it('connect-src allows only this site and the pinned Supabase project by default', () => {
    const csp = directives(securityHeaders()['Content-Security-Policy']!)
    expect(PRODUCTION_SUPABASE_ORIGIN).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/)
    expect(csp.get('connect-src')).toEqual(["'self'", PRODUCTION_SUPABASE_ORIGIN])
  })

  it('has no wildcard, scheme-wide or WebSocket sources anywhere', () => {
    for (const [name, sources] of directives(securityHeaders()['Content-Security-Policy']!)) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(/\*|^wss?:|^https?:$/)
      }
    }
    expect(directives(securityHeaders()['Content-Security-Policy']!).get('font-src')).toEqual(["'self'"])
  })

  it('vercel.json sends exactly the generated headers on every route', () => {
    expect(missingOrDifferent(vercelRules(read('vercel.json')))).toEqual([])
  })

  it('netlify.toml sends exactly the generated headers on every route', () => {
    expect(missingOrDifferent(netlifyRules(read('netlify.toml')))).toEqual([])
  })

  it('would notice a narrowed rule or a scoped override (the check itself works)', () => {
    const vercel = read('vercel.json')
    const netlify = read('netlify.toml')
    expect(missingOrDifferent(vercelRules(vercel.replace('"/(.*)"', '"/never-used/:path*"')))).not.toEqual([])
    expect(
      missingOrDifferent(netlifyRules(netlify.replace('for = "/*"', 'for = "/never-used/*"'))),
    ).not.toEqual([])
    // A later rule that loosens one route's policy.
    const config = JSON.parse(vercel) as { headers: unknown[] }
    config.headers.push({
      source: '/scan/:id',
      headers: [{ key: 'Content-Security-Policy', value: 'default-src *' }],
    })
    expect(missingOrDifferent(vercelRules(JSON.stringify(config)))).toEqual([
      '/scan/0b6f3f7e-1a2b-4c3d-9e8f-001122334455 Content-Security-Policy',
    ])
  })

  it('treats field names case-insensitively, so a differently cased override is noticed too (R6-02)', () => {
    const loosen = (source: string) => {
      const config = JSON.parse(read('vercel.json')) as { headers: unknown[] }
      config.headers.push({ source, headers: [{ key: 'content-security-policy', value: 'default-src *' }] })
      return missingOrDifferent(vercelRules(JSON.stringify(config)))
    }
    expect(loosen('/scan/:id')).toEqual([
      '/scan/0b6f3f7e-1a2b-4c3d-9e8f-001122334455 Content-Security-Policy',
    ])
    expect(loosen('/assets/(.*)')).toEqual(['/assets/index-abc123.js Content-Security-Policy'])
    expect(loosen('/index.html')).toEqual(['/index.html Content-Security-Policy'])

    const netlify = read('netlify.toml').replace(
      'Cache-Control = "public, max-age=31536000, immutable"',
      'Cache-Control = "public, max-age=31536000, immutable"\n    x-frame-options = "SAMEORIGIN"',
    )
    expect(missingOrDifferent(netlifyRules(netlify))).toEqual(['/assets/index-abc123.js X-Frame-Options'])
  })

  it('reads every valid TOML form, so quoted keys and literal strings are checked too (R7-03)', () => {
    const scoped = (line: string) =>
      missingOrDifferent(
        netlifyRules(
          `${read('netlify.toml')}\n[[headers]]\n  for = "/scan/*"\n  [headers.values]\n    ${line}\n`,
        ),
      )
    const scanner = ['/scan/0b6f3f7e-1a2b-4c3d-9e8f-001122334455 Content-Security-Policy']
    expect(scoped(`"content-security-policy" = "default-src *"`)).toEqual(scanner)
    expect(scoped(`content-security-policy = 'default-src *'`)).toEqual(scanner)
    expect(scoped(`'Content-Security-Policy' = 'default-src *'`)).toEqual(scanner)
  })
})
