import { useCallback, useEffect, useRef } from 'react'

/**
 * For async handlers: `isCurrent()` turns false once the component that started
 * them unmounts, for example when the route moves to another event. Check it
 * after each await before navigating or updating the screen, so an operation
 * that finishes late cannot redirect or overwrite the page now shown (R12-02).
 * The operation itself still completes.
 */
export function useIsCurrent(): () => boolean {
  const current = useRef(true)
  useEffect(() => {
    current.current = true
    return () => {
      current.current = false
    }
  }, [])
  return useCallback(() => current.current, [])
}
