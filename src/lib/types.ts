export type EventStatus = 'draft' | 'published' | 'closed' | 'archived'
export type RegistrationStatus = 'registered' | 'checked_in' | 'revoked'
export type StaffRole = 'organizer' | 'operator'
export type AdmissionResult = 'admitted' | 'already_used' | 'invalid' | 'revoked' | 'wrong_event'
export type RegistrationState = 'open' | 'not_open' | 'closed' | 'full' | 'draft' | 'archived'

export interface PublicEvent {
  name: string
  slug: string
  description: string | null
  location: string | null
  timezone: string
  starts_at: string
  ends_at: string | null
  registration_opens_at: string | null
  registration_closes_at: string | null
  status: EventStatus
}

export interface EventRow {
  id: string
  name: string
  slug: string
  description: string | null
  location: string | null
  timezone: string
  starts_at: string
  ends_at: string | null
  registration_opens_at: string | null
  registration_closes_at: string | null
  status: EventStatus
  max_attendees: number | null
  created_at: string
  updated_at: string
  created_by: string | null
}

export type EventInput = Pick<
  EventRow,
  | 'name'
  | 'slug'
  | 'description'
  | 'location'
  | 'timezone'
  | 'starts_at'
  | 'ends_at'
  | 'registration_opens_at'
  | 'registration_closes_at'
  | 'status'
  | 'max_attendees'
>

export interface EventSummary {
  id: string
  name: string
  slug: string
  status: EventStatus
  starts_at: string
  ends_at: string | null
  location: string | null
  timezone: string
  max_attendees: number | null
  my_role: 'admin' | StaffRole | null
  registered_count: number
  checked_in_count: number
  revoked_count: number
}

export interface Registration {
  id: string
  event_id: string
  first_name: string
  last_name: string
  email: string | null
  status: RegistrationStatus
  registered_at: string
  checked_in_at: string | null
  checked_in_by: string | null
  revoked_at: string | null
  token_issued_at: string
  token_version: number
}

export interface PassView {
  first_name: string
  last_name: string
  status: RegistrationStatus
  registered_at: string
  checked_in_at: string | null
}

export interface AdmissionResponse {
  result: AdmissionResult
  reason: string
  attendee: { first_name: string; last_name: string } | null
  checked_in_at: string | null
  event: { id: string; name: string }
  scanned_at: string
}

export interface StaffMember {
  id: string
  user_id: string
  email: string | null
  display_name: string | null
  role: StaffRole
  created_at: string
}

export interface Profile {
  id: string
  email: string | null
  display_name: string | null
  is_admin: boolean
  created_at: string
}

export interface AdmissionLog {
  id: string
  registration_id: string | null
  event_id: string
  operator_id: string | null
  attempted_at: string
  result: AdmissionResult
  details: Record<string, unknown>
}
