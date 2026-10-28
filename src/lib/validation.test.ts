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

describe('invisible and formatting characters', () => {
  it('rejects names that are invisible or reverse text', () => {
    for (const name of ['​', '‮gnp.exe', '⁦x⁩', '­', '-', "''"]) {
      expect(
        validateRegistration({ firstName: name, lastName: 'B', email: '' }).firstName,
        JSON.stringify(name),
      ).toBeTruthy()
    }
  })
})

describe('phone', () => {
  it('is optional and accepts international format with spaces or dashes', () => {
    expect(validateRegistration({ firstName: 'A', lastName: 'B', email: '', phone: '' })).toEqual({})
    for (const ok of ['+971 50 123 4567', '+44 20-7946-0958', '(+381) 64 123 4567']) {
      expect(validateRegistration({ firstName: 'A', lastName: 'B', email: '', phone: ok }), ok).toEqual({})
    }
  })
  it('requires the + country code', () => {
    for (const bad of ['0501234567', '971501234567', '+0 50 123', '+971 50 ABC', '+1234']) {
      expect(
        validateRegistration({ firstName: 'A', lastName: 'B', email: '', phone: bad }).phone,
        bad,
      ).toBeTruthy()
    }
  })
})
