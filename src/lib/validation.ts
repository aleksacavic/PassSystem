/** Client-side registration validation. Mirrors private.clean_name() and the email check in SQL. */

export const NAME_MAX = 100
export const EMAIL_MAX = 254

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function validateName(value: string, label: string): string | null {
  const v = cleanName(value)
  if (!v) return `${label} is required.`
  if (v.length > NAME_MAX) return `${label} must be at most ${NAME_MAX} characters.`
  if (CONTROL_RE.test(value) || /[<>]/.test(v)) return `${label} contains characters that are not allowed.`
  return null
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function validateEmail(value: string): string | null {
  const v = normalizeEmail(value)
  if (!v) return null
  if (v.length > EMAIL_MAX || !EMAIL_RE.test(v)) return 'Enter a valid email address or leave it empty.'
  return null
}

export interface RegistrationInput {
  firstName: string
  lastName: string
  email: string
}

export type RegistrationErrors = Partial<Record<keyof RegistrationInput, string>>

export function validateRegistration(input: RegistrationInput): RegistrationErrors {
  const errors: RegistrationErrors = {}
  const first = validateName(input.firstName, 'First name')
  const last = validateName(input.lastName, 'Last name')
  const email = validateEmail(input.email)
  if (first) errors.firstName = first
  if (last) errors.lastName = last
  if (email) errors.email = email
  return errors
}
