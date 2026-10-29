// The production security headers, as generated and as deployed to every route (F-15, R4-07, R5-04).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  headers: Record<string, string>
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
      headers: Object.fromEntries(rule.headers.map((h) => [h.key, h.value])),
    }
  })
}

/** Netlify `[[headers]]` blocks: a `for` glob and its `[headers.values]`. */
function netlifyRules(toml: string): Rule[] {
  return toml
    .split(/^\[\[headers\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const glob = /^\s*for\s*=\s*"(.*)"\s*$/m.exec(block)![1]!
      const re = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      const values = block.split(/^\s*\[headers\.values\]\s*$/m)[1] ?? ''
      return {
        matches: (path) => re.test(path),
        headers: Object.fromEntries(
          [...values.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)].map((m) => [m[1]!, m[2]!]),
        ),
      }
    })
}

/** Headers a request for `path` receives: every matching rule applies, later ones win. */
const effective = (rules: Rule[], path: string) =>
  Object.assign({}, ...rules.filter((r) => r.matches(path)).map((r) => r.headers)) as Record<string, string>

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
    for (const [key, value] of Object.entries(expected))
      if (got[key] !== value) problems.push(`${path} ${key}`)
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
})
