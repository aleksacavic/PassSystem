import { Link } from 'react-router'
import { PublicLayout } from '../../components/PublicLayout'
import { Card } from '../../components/ui'

/** Shown instead of a stack trace when a route fails to render. */
export default function RouteErrorPage() {
  return (
    <PublicLayout>
      <Card className="p-6 text-center">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-ink-600">The page could not be shown. Check the link or start again.</p>
        <Link to="/" className="mt-4 inline-block font-semibold text-accent-600 underline">
          Go to start page
        </Link>
      </Card>
    </PublicLayout>
  )
}
