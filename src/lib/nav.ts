/**
 * Only allow same-app redirects (prevents open redirects via ?next=).
 * The value is resolved the way the browser would resolve it (which strips tabs
 * and newlines and treats `/\` like `//`), and only a same-origin result is kept.
 */
export function safeNext(next: string | null, origin: string = window.location.origin): string {
  if (!next || !next.startsWith('/')) return '/admin'
  try {
    const url = new URL(next, origin)
    if (url.origin !== origin) return '/admin'
    const path = url.pathname + url.search + url.hash
    // A path that still starts with // would be treated as protocol-relative.
    return path.startsWith('//') ? '/admin' : path
  } catch {
    return '/admin'
  }
}
