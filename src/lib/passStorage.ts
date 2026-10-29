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

/** When this pass leaves the device (Infinity if its start date cannot be read). */
function expiresAt(p: StoredPass): number {
  const start = Date.parse(p.startsAt)
  return Number.isNaN(start) ? Infinity : start + KEEP_AFTER_START_MS
}

const FIELDS = ['token', 'slug', 'eventName', 'attendeeName', 'startsAt', 'savedAt'] as const

/** A stored entry is used only if every field is a string (storage can be edited or corrupted). */
function wellFormed(p: unknown): p is StoredPass {
  return (
    typeof p === 'object' &&
    p !== null &&
    FIELDS.every((k) => typeof (p as Record<string, unknown>)[k] === 'string')
  )
}

export function loadPasses(): StoredPass[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as unknown[]).filter(wellFormed).filter((p) => current(p)) : []
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
  // Timers count elapsed time, not the wall clock: after the device clock jumps
  // forward, or when the tab comes back, recheck deadlines (R16-03). The snapshot
  // stays the same array unless a pass actually expired.
  const onReturn = () => {
    if (document.visibilityState === 'visible') listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  window.addEventListener('focus', onReturn)
  document.addEventListener('visibilitychange', onReturn)
  armExpiry()
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('focus', onReturn)
    document.removeEventListener('visibilitychange', onReturn)
    if (listeners.size === 0) armExpiry()
  }
}

let cached: { raw: string | null; passes: StoredPass[]; validUntil: number } | null = null
let expiryTimer: ReturnType<typeof setTimeout> | undefined

/**
 * The same array until the stored value changes or the next pass reaches its
 * retention deadline, as useSyncExternalStore requires (R15-01).
 */
function snapshot(): StoredPass[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    /* unavailable: treated as empty */
  }
  if (!cached || cached.raw !== raw || Date.now() >= cached.validUntil) {
    const passes = loadPasses()
    cached = { raw, passes, validUntil: Math.min(Infinity, ...passes.map(expiresAt)) }
    armExpiry()
  }
  return cached.passes
}

/** While a list is shown, refresh it when its next pass expires. */
function armExpiry() {
  clearTimeout(expiryTimer)
  expiryTimer = undefined
  if (!cached || listeners.size === 0 || cached.validUntil === Infinity) return
  // setTimeout takes at most 2^31-1 ms (about 24 days): a longer wait re-arms when it fires.
  const wait = Math.min(Math.max(cached.validUntil - Date.now(), 0) + 1, 2 ** 31 - 1)
  expiryTimer = setTimeout(() => {
    if (cached && Date.now() < cached.validUntil) armExpiry()
    else notify()
  }, wait)
}

const none: StoredPass[] = []

/** Saved passes, kept up to date when one is saved or removed (in this or another tab). */
export function useStoredPasses(): StoredPass[] {
  return useSyncExternalStore(subscribe, snapshot, () => none)
}

export function passesForEvent(slug: string): StoredPass[] {
  return loadPasses().filter((p) => p.slug === slug)
}
