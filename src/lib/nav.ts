/** Only allow same-app relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/admin'
  return next
}
