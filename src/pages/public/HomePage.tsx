import { useState } from 'react'
import { Link } from 'react-router'
import { formatEventDate } from '../../lib/datetime'
import { useT } from '../../lib/i18n'
import { loadPasses } from '../../lib/passStorage'
import { LogoMark } from '../../components/Logo'
import { PublicLayout } from '../../components/PublicLayout'
import { ButtonLink, Card } from '../../components/ui'

export default function HomePage() {
  const [passes] = useState(loadPasses)
  const { t, locale } = useT()
  return (
    <PublicLayout>
      <div className="space-y-6">
        <div className="flex flex-col items-center pt-6 text-center">
          <LogoMark className="size-14" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">PassSystem</h1>
          <p className="mt-2 text-fg-muted">{t('home.intro')}</p>
        </div>

        {passes.length > 0 && (
          <Card>
            <h2 className="border-b border-line-soft px-5 py-3 text-base font-semibold">
              {t('home.passes')}
            </h2>
            <ul className="divide-y divide-line-soft">
              {passes.map((p) => (
                <li key={p.token}>
                  <Link to={`/pass#${p.token}`} className="block px-5 py-3 hover:bg-surface-sunk">
                    <p className="font-semibold" dir="auto">
                      {p.eventName}
                    </p>
                    <p className="text-sm text-fg-muted">
                      {p.attendeeName} · {formatEventDate(p.startsAt, null, null, locale)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="text-center">
          <ButtonLink to="/admin" variant="secondary">
            {t('home.staff')}
          </ButtonLink>
        </div>
      </div>
    </PublicLayout>
  )
}
