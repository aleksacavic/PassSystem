import { useSyncExternalStore } from 'react'

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
/** Passes are dropped from this device once their event is well over. */
const KEEP_AFTER_START_MS = 3 * 24 * 60 * 60 * 1000

function current(p: StoredPass, now = Date.now()): boolean {
  const start = Date.parse(p.startsAt)
  return Number.isNaN(start) || start + KEEP_AFTER_START_MS > now
}

export function loadPasses(): StoredPass[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? (parsed as StoredPass[]).filter((p) => p && typeof p.token === 'string' && current(p))
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
  notify()
}

export function forgetPass(token: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadPasses().filter((p) => p.token !== token)))
  } catch {
    /* ignore */
  }
  notify()
}

// Pages showing saved passes follow changes as they happen (R14-01): a pass saved
// after the guest left the form (it finished late) appears on the page now shown.
// A write in this document does not fire `storage` here, so savePass/forgetPass
// notify directly; the `storage` event covers other tabs.
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

let cached: { raw: string | null; passes: StoredPass[] } | null = null

/** The same array until the stored value changes, as useSyncExternalStore requires. */
function snapshot(): StoredPass[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    /* unavailable: treated as empty */
  }
  if (!cached || cached.raw !== raw) cached = { raw, passes: loadPasses() }
  return cached.passes
}

const none: StoredPass[] = []

/** Saved passes, kept up to date when one is saved or removed (in this or another tab). */
export function useStoredPasses(): StoredPass[] {
  return useSyncExternalStore(subscribe, snapshot, () => none)
}

export function passesForEvent(slug: string): StoredPass[] {
  return loadPasses().filter((p) => p.slug === slug)
}
