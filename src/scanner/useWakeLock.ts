import { useEffect } from 'react'

interface WakeLockSentinelLike {
  release(): Promise<void>
}

/** Keep the screen on while scanning (Screen Wake Lock API, where available). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const wl = (
      navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
    ).wakeLock
    if (!wl) return
    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false
    const acquire = () => {
      wl.request('screen')
        .then((s) => {
          if (cancelled) void s.release()
          else sentinel = s
        })
        .catch(() => undefined)
    }
    acquire()
    const onVisible = () => document.visibilityState === 'visible' && acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => undefined)
    }
  }, [active])
}
