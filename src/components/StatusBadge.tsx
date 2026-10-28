import type { EventStatus, RegistrationStatus } from '../lib/types'
import { Badge } from './ui'

export function RegistrationStatusBadge({ status }: { status: RegistrationStatus }) {
  if (status === 'checked_in') return <Badge tone="ok">Checked in</Badge>
  if (status === 'revoked') return <Badge tone="bad">Revoked</Badge>
  return <Badge tone="neutral">Registered</Badge>
}

export function EventStatusBadge({ status }: { status: EventStatus }) {
  switch (status) {
    case 'published':
      return <Badge tone="ok">Published</Badge>
    case 'closed':
      return <Badge tone="warn">Registration closed</Badge>
    case 'archived':
      return <Badge tone="neutral">Archived</Badge>
    default:
      return <Badge tone="accent">Draft</Badge>
  }
}
