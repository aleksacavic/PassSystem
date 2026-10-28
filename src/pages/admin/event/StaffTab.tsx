import { UserMinus, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../../auth/AuthProvider'
import { addEventStaff, listEventStaff, removeEventStaff } from '../../../lib/api'
import type { EventRow, StaffMember, StaffRole } from '../../../lib/types'
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '../../../components/ui'

export function StaffTab({ event, isAdmin }: { event: EventRow; isAdmin: boolean }) {
  const { session } = useAuth()
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<StaffRole>('operator')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    listEventStaff(event.id)
      .then(setStaff)
      .catch((e: Error) => setError(e.message))
  }, [event.id])

  useEffect(load, [load])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addEventStaff(event.id, email.trim(), role)
      setEmail('')
      load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function onRemove(m: StaffMember) {
    if (!window.confirm(`Remove ${m.email} from this event?`)) return
    setError(null)
    try {
      await removeEventStaff(m.id)
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader
          title="Event staff"
          description="Operators can scan passes. Organizers can also manage attendees and staff."
        />
        {!staff ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : staff.length === 0 ? (
          <p className="p-6 text-center text-fg-subtle">
            No staff assigned. Administrators always have access.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {staff.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{m.display_name || m.email}</p>
                  {m.display_name && <p className="truncate text-sm text-fg-subtle">{m.email}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={m.role === 'organizer' ? 'accent' : 'neutral'}>
                    {m.role === 'organizer' ? 'Organizer' : 'Operator'}
                  </Badge>
                  {(isAdmin || m.role === 'operator') && m.user_id !== session?.user.id && (
                    <Button variant="danger-ghost" size="sm" icon={UserMinus} onClick={() => onRemove(m)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="h-fit p-5">
        <h2 className="text-base font-semibold">Assign staff</h2>
        <p className="mt-1 text-sm text-fg-muted">
          The person must already have a staff account. Administrators create accounts.
        </p>
        <form className="mt-4 space-y-4" onSubmit={onAdd}>
          <Field label="Staff email">
            {(p) => (
              <Input
                {...p}
                type="email"
                autoCapitalize="none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Role">
            {(p) => (
              <Select {...p} value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
                <option value="operator">Operator — scanning only</option>
                {isAdmin && <option value="organizer">Organizer — full event management</option>}
              </Select>
            )}
          </Field>
          {error && <Alert tone="bad">{error}</Alert>}
          <Button type="submit" icon={UserPlus} loading={busy} block>
            Assign
          </Button>
        </form>
      </Card>
    </div>
  )
}
