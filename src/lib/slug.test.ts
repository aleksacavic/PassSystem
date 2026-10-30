import { describe, expect, it } from 'vitest'
import { isValidSlug, slugify } from './slug'

describe('slugify', () => {
  it('creates URL-safe slugs', () => {
    expect(slugify('Community Gathering 2026!')).toBe('community-gathering-2026')
    expect(slugify('Đurđevdan – Žurka u Šapcu')).toBe('durdevdan-zurka-u-sapcu')
    expect(slugify('  --Hello--  ')).toBe('hello')
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
  it('validates', () => {
    expect(isValidSlug('community-gathering')).toBe(true)
    expect(isValidSlug('a')).toBe(true)
    expect(isValidSlug('-bad')).toBe(false)
    expect(isValidSlug('Bad')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })
})
