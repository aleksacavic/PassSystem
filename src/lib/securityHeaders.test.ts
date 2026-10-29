// The production Content-Security-Policy, as generated and as deployed (F-15, R4-07).
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
const vercelHeaders = () => {
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as {
    headers: { headers: { key: string; value: string }[] }[]
  }
  return Object.fromEntries(config.headers.flatMap((h) => h.headers).map((h) => [h.key, h.value]))
}
const netlifyHeaders = () => {
  const toml = readFileSync(resolve(root, 'netlify.toml'), 'utf8')
  return Object.fromEntries(
    [...toml.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)].map((m) => [m[1], m[2]]),
  )
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

  it('vercel.json and netlify.toml deploy exactly the generated headers', () => {
    const expected = securityHeaders()
    for (const deployed of [vercelHeaders(), netlifyHeaders()]) {
      for (const [key, value] of Object.entries(expected)) expect(deployed[key], key).toBe(value)
    }
  })
})
