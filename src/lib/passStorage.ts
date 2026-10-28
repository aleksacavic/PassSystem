/**
 * Convenience copy of passes issued in this browser. Secondary only: the
 * authoritative record is the database, and the pass URL works on any device.
 */
export interface StoredPass {
  token: string
  slug: string
  eventName: string
  attendeeName: string
  startsAt: string
  savedAt: string
}

const KEY = 'passsystem.passes.v1'
const MAX = 20

export function loadPasses(): StoredPass[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? (parsed as StoredPass[]).filter((p) => p && typeof p.token === 'string')
      : []
  } catch {
    return []
  }
}

export function savePass(pass: StoredPass): void {
  try {
    const rest = loadPasses().filter((p) => p.token !== pass.token)
    localStorage.setItem(KEY, JSON.stringify([pass, ...rest].slice(0, MAX)))
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

export function forgetPass(token: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadPasses().filter((p) => p.token !== token)))
  } catch {
    /* ignore */
  }
}

export function passesForEvent(slug: string): StoredPass[] {
  return loadPasses().filter((p) => p.slug === slug)
}
