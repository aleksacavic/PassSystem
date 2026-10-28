import { useState } from 'react'
import { Link } from 'react-router'
import { formatEventDate } from '../../lib/datetime'
import { loadPasses } from '../../lib/passStorage'
import { LogoMark } from '../../components/Logo'
import { PublicLayout } from '../../components/PublicLayout'
import { ButtonLink, Card } from '../../components/ui'

export default function HomePage() {
  const [passes] = useState(loadPasses)
  return (
    <PublicLayout>
      <div className="space-y-6">
        <div className="flex flex-col items-center pt-6 text-center">
          <LogoMark className="size-14" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">PassSystem</h1>
          <p className="mt-2 text-fg-muted">
            Event registration and QR entry passes. To register, open the link or QR code shared by the event
            organizer.
          </p>
        </div>

        {passes.length > 0 && (
          <Card>
            <h2 className="border-b border-line-soft px-5 py-3 text-base font-semibold">
              Passes on this device
            </h2>
            <ul className="divide-y divide-line-soft">
              {passes.map((p) => (
                <li key={p.token}>
                  <Link to={`/pass#${p.token}`} className="block px-5 py-3 hover:bg-surface-sunk">
                    <p className="font-semibold">{p.eventName}</p>
                    <p className="text-sm text-fg-muted">
                      {p.attendeeName} · {formatEventDate(p.startsAt, null)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="text-center">
          <ButtonLink to="/admin" variant="secondary">
            Staff sign in
          </ButtonLink>
        </div>
      </div>
    </PublicLayout>
  )
}
