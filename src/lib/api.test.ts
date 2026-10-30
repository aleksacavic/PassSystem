import { describe, expect, it } from 'vitest'
import { sanitizeSearchTerm } from './api'

describe('sanitizeSearchTerm', () => {
  it('strips PostgREST/LIKE metacharacters', () => {
    expect(sanitizeSearchTerm('ana),status.eq.revoked')).toBe('anastatus.eq.revoked')
    expect(sanitizeSearchTerm('100%_x*')).toBe('100x')
    expect(sanitizeSearchTerm(`O'Brien`)).toBe(`O'Brien`)
  })
})
