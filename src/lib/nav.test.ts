import { describe, expect, it } from 'vitest'
import { safeNext } from './nav'

const origin = 'https://passes.example.org'

describe('safeNext', () => {
  it('allows in-app paths', () => {
    expect(safeNext('/scan/abc?x=1', origin)).toBe('/scan/abc?x=1')
    expect(safeNext('/admin/events/1?tab=staff#x', origin)).toBe('/admin/events/1?tab=staff#x')
  })
  it('blocks open redirects', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/%5Cevil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n/evil.example',
      'javascript:alert(1)',
      '',
    ]) {
      const out = safeNext(bad, origin)
      expect(new URL(out, origin).origin, JSON.stringify(bad)).toBe(origin)
      expect(out.startsWith('//'), JSON.stringify(bad)).toBe(false)
    }
    expect(safeNext(null, origin)).toBe('/admin')
    expect(safeNext('/\t/localhost:4199/pwned', origin)).toBe('/admin')
  })
})
