import { describe, expect, it } from 'vitest'
import { safeNext } from './nav'

describe('safeNext', () => {
  it('allows in-app paths', () => expect(safeNext('/scan/abc?x=1')).toBe('/scan/abc?x=1'))
  it('blocks open redirects', () => {
    expect(safeNext('https://evil.example')).toBe('/admin')
    expect(safeNext('//evil.example')).toBe('/admin')
    expect(safeNext('/\\evil.example')).toBe('/admin')
    expect(safeNext(null)).toBe('/admin')
  })
})
