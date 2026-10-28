import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { listProfiles, setUserAdmin } from '../../lib/api'
import { formatDateTime } from '../../lib/datetime'
import type { Profile } from '../../lib/types'
import { PageHeader } from '../../components/AdminLayout'
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui'

export default function UsersPage() {
  const { session } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    listProfiles()
      .then(setUsers)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  async function toggle(u: Profile) {
    const verb = u.is_admin ? 'Remove administrator rights from' : 'Make administrator:'
    if (!window.confirm(`${verb} ${u.email}?`)) return
    try {
      await setUserAdmin(u.id, !u.is_admin)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Staff accounts"
        description="Everyone who can sign in. Assign people to events from each event’s Staff tab."
      />
      <Alert tone="info" title="Adding a staff member" className="mb-5">
        Public sign-up is disabled. Create or invite the person in the Supabase dashboard (Authentication →
        Users → Add user / Invite), or run <code className="font-mono">npm run staff:create</code>. They
        appear here after their first account is created.
      </Alert>
      {error && (
        <Alert tone="bad" className="mb-4">
          {error}
        </Alert>
      )}
      <Card>
        {!users ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{u.email}</p>
                  <p className="text-xs text-ink-500">Added {formatDateTime(u.created_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {u.is_admin ? <Badge tone="accent">Administrator</Badge> : <Badge>Staff</Badge>}
                  {u.id !== session?.user.id && (
                    <Button variant="ghost" size="sm" onClick={() => toggle(u)}>
                      {u.is_admin ? 'Remove admin' : 'Make admin'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
