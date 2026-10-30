import { describe, expect, it } from 'vitest'
import { extractPassToken, formatPassToken, normalizePassToken } from './passToken'

const T = '87J813AZE9GZXK95NP3GA5F4'

describe('normalizePassToken', () => {
  it('accepts canonical tokens', () => expect(normalizePassToken(T)).toBe(T))
  it('accepts grouped, lowercase and spaced input', () => {
    expect(normalizePassToken('87j8-13az-e9gz-xk95-np3g-a5f4')).toBe(T)
    expect(normalizePassToken(' 87J8 13AZ E9GZ XK95 NP3G A5F4 ')).toBe(T)
  })
  it('maps Crockford aliases O->0, I/L->1', () => {
    expect(normalizePassToken('OOOOIIIILLLL000011112222')).toBe('000011111111000011112222')
  })
  it('rejects wrong length, U, and non-alphanumerics', () => {
    expect(normalizePassToken(T.slice(1))).toBeNull()
    expect(normalizePassToken(T + 'A')).toBeNull()
    expect(normalizePassToken('U' + T.slice(1))).toBeNull()
    expect(normalizePassToken("'; drop table registrations;--")).toBeNull()
    expect(normalizePassToken('x'.repeat(500))).toBeNull()
  })
})

describe('extractPassToken', () => {
  it('reads pass URLs with fragment', () => {
    expect(extractPassToken(`https://passes.example.org/pass#${T}`)).toBe(T)
  })
  it('reads legacy path and query formats', () => {
    expect(extractPassToken(`https://x.example/p/${T}`)).toBe(T)
    expect(extractPassToken(`https://x.example/pass?t=${T}`)).toBe(T)
  })
  it('reads bare codes typed manually', () => expect(extractPassToken(formatPassToken(T))).toBe(T))
  it('rejects unrelated QR content', () => {
    expect(extractPassToken('https://example.com/menu')).toBeNull()
    expect(extractPassToken('WIFI:S:venue;T:WPA;P:secret;;')).toBeNull()
    expect(extractPassToken('Ana Petrović')).toBeNull()
    expect(extractPassToken('')).toBeNull()
  })
})

describe('formatPassToken', () => {
  it('groups in fours', () => expect(formatPassToken(T)).toBe('87J8-13AZ-E9GZ-XK95-NP3G-A5F4'))
})
