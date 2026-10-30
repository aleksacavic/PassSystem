import { useEffect, useRef } from 'react'

/** Run `fn` every `ms` while the page is visible, and when it becomes visible again. */
export function usePolling(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])
  useEffect(() => {
    if (!enabled) return
    const tick = () => document.visibilityState === 'visible' && ref.current()
    const id = window.setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms, enabled])
}
