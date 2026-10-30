/** Client-side registration validation. Mirrors private.clean_name() and the email check in SQL. */

export const NAME_MAX = 100
export const EMAIL_MAX = 254

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
// Zero-width, bidi override/isolate, BOM and soft-hyphen characters.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u

export function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().normalize('NFC')
}

export type NameProblem = 'required' | 'too_long' | 'invalid_chars' | 'no_letter'

export function nameProblem(value: string): NameProblem | null {
  const v = cleanName(value)
  if (!v) return 'required'
  if (v.length > NAME_MAX) return 'too_long'
  if (CONTROL_RE.test(value) || INVISIBLE_RE.test(v) || /[<>]/.test(v)) return 'invalid_chars'
  if (!LETTER_OR_DIGIT_RE.test(v)) return 'no_letter'
  return null
}

export function validateName(value: string, label: string): string | null {
  switch (nameProblem(value)) {
    case 'required':
      return `${label} is required.`
    case 'too_long':
      return `${label} must be at most ${NAME_MAX} characters.`
    case 'invalid_chars':
      return `${label} contains characters that are not allowed.`
    case 'no_letter':
      return `${label} must contain at least one letter.`
    default:
      return null
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function emailInvalid(value: string): boolean {
  const v = normalizeEmail(value)
  return Boolean(v) && (v.length > EMAIL_MAX || !EMAIL_RE.test(v))
}

export function validateEmail(value: string): string | null {
  return emailInvalid(value) ? 'Enter a valid email address or leave it empty.' : null
}

/** "+971 50 123 4567" -> "+971501234567" (mirrors private.clean_phone). */
export function cleanPhone(value: string): string {
  return value.trim().replace(/[\s().-]/g, '')
}

export function phoneInvalid(value: string): boolean {
  if (!value.trim()) return false
  return value.length > 40 || !/^\+[1-9][0-9]{7,14}$/.test(cleanPhone(value))
}

export function validatePhone(value: string): string | null {
  return phoneInvalid(value)
    ? 'Enter the number with country code, e.g. +971 50 123 4567, or leave it empty.'
    : null
}

export interface RegistrationInput {
  firstName: string
  lastName: string
  email: string
  phone?: string
}

export type RegistrationErrors = Partial<Record<keyof RegistrationInput, string>>

export function validateRegistration(input: RegistrationInput): RegistrationErrors {
  const errors: RegistrationErrors = {}
  const first = validateName(input.firstName, 'First name')
  const last = validateName(input.lastName, 'Last name')
  const email = validateEmail(input.email)
  const phone = validatePhone(input.phone ?? '')
  if (first) errors.firstName = first
  if (last) errors.lastName = last
  if (email) errors.email = email
  if (phone) errors.phone = phone
  return errors
}
