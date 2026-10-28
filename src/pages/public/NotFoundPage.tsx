import { Link } from 'react-router'
import { PublicLayout } from '../../components/PublicLayout'
import { Card } from '../../components/ui'

export default function NotFoundPage() {
  return (
    <PublicLayout>
      <Card className="p-6 text-center">
        <h1 className="text-xl font-bold">Page not found</h1>
        <p className="mt-2 text-ink-600">The link may be mistyped or no longer valid.</p>
        <Link to="/" className="mt-4 inline-block font-semibold text-accent-600 underline">
          Go to start page
        </Link>
      </Card>
    </PublicLayout>
  )
}
