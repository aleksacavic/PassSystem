import type { PostgrestError } from '@supabase/supabase-js'

const MESSAGES: Record<string, string> = {
  rate_limited: 'Too many attempts from this network. Please wait a minute and try again.',
  event_not_found: 'This event could not be found.',
  registration_closed: 'Registration for this event is closed.',
  registration_not_open: 'Registration for this event has not opened yet.',
  event_full: 'This event has reached its maximum capacity.',
  invalid_input: 'Please check the details you entered.',
  duplicate_request: 'This registration was already submitted. Please reload the page to register again.',
  pass_not_found: 'This pass could not be found. It may have been replaced by a newer pass.',
  not_authenticated: 'Please sign in again.',
  not_authorized: 'You do not have permission to do this.',
  admin_required: 'Only administrators can do this.',
  invalid_state: 'This action is not possible in the pass’s current state.',
  user_not_found: 'No staff account exists with that email address.',
  self_demotion: 'You cannot remove your own administrator rights.',
  event_archived: 'This event is archived. Scanning is disabled.',
  user_not_confirmed:
    'This person has not accepted their invite yet. Try again after they set their password.',
  last_admin: 'At least one administrator must remain.',
}

export function messageFor(
  code: string | undefined | null,
  fallback = 'Something went wrong. Please try again.',
) {
  return (code && MESSAGES[code]) || fallback
}

/** Stable error code from a PostgREST error (we put codes in the HINT field). */
export function errorCode(
  error: Pick<PostgrestError, 'hint' | 'code' | 'message'> | null | undefined,
): string | null {
  if (!error) return null
  if (error.hint && MESSAGES[error.hint]) return error.hint
  if (error.code === '42501') return 'not_authorized'
  return null
}

export function describeError(error: unknown): string {
  if (!error) return messageFor(null)
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const e = error as PostgrestError
    const code = errorCode(e)
    if (code) return messageFor(code)
    if (e.code === '23505') return 'That value is already in use.'
    if (e.code === '23514') return 'Some values are invalid. Please review the form.'
    if (e.code === '22023' && /time zone/i.test(e.message)) return 'Unknown time zone.'
    if (/Failed to fetch|NetworkError|Load failed/i.test(e.message))
      return 'Network error. Check your connection and try again.'
    return e.message || messageFor(null)
  }
  return messageFor(null)
}

export class ApiError extends Error {
  code: string | null
  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}
