import { describe, expect, it } from 'vitest'
import { validateRegistration } from './validation'

describe('validateRegistration', () => {
  it('requires first and last name, email optional', () => {
    expect(validateRegistration({ firstName: 'Ana', lastName: 'Petrović', email: '' })).toEqual({})
    const e = validateRegistration({ firstName: '  ', lastName: '', email: '' })
    expect(e.firstName).toBeTruthy()
    expect(e.lastName).toBeTruthy()
  })
  it('validates email when present', () => {
    expect(validateRegistration({ firstName: 'A', lastName: 'B', email: 'ana@example.org' })).toEqual({})
    expect(validateRegistration({ firstName: 'A', lastName: 'B', email: 'not-an-email' }).email).toBeTruthy()
  })
  it('rejects markup and overlong names', () => {
    expect(validateRegistration({ firstName: '<script>', lastName: 'B', email: '' }).firstName).toBeTruthy()
    expect(
      validateRegistration({ firstName: 'a'.repeat(101), lastName: 'B', email: '' }).firstName,
    ).toBeTruthy()
  })
  it('accepts apostrophes, hyphens and diacritics', () => {
    expect(validateRegistration({ firstName: "D'Arcy", lastName: 'Jean-Luc Đokić', email: '' })).toEqual({})
  })
})
