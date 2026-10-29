import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePolling } from './usePolling'

/**
 * A server-paged list (search, filter, page) that reloads on its own while shown.
 *
 * `query` identifies what is on screen (e.g. JSON of [search, filter, page]); `fetch`
 * loads exactly that. A response is applied only if it is for the query still shown
 * (R16-02, R17-01) and newer than the last response applied, so an older response
 * that arrives late never replaces newer rows, while a slow response is still used
 * even if a later poll has started meanwhile (R18-02). A poll is skipped while a
 * request for the query shown is still on its way, so a slow network does not pile up
 * requests.
 */
export function usePagedList<T>(query: string, fetch: () => Promise<T>, pollMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(0)
  const applied = useRef(0)
  const shown = useRef(query)
  const inFlight = useRef<{ request: number; query: string } | null>(null)

  useLayoutEffect(() => {
    shown.current = query
  }, [query])

  const load = useCallback(() => {
    const request = ++started.current
    inFlight.current = { request, query }
    const current = () => query === shown.current && request > applied.current
    fetch()
      .then((d) => {
        if (!current()) return
        applied.current = request
        setData(d)
        setError(null)
      })
      .catch((e: Error) => current() && setError(e.message))
      .finally(() => {
        if (inFlight.current?.request === request) inFlight.current = null
      })
  }, [query, fetch])

  // Callbacks that outlive a render (a dialog finishing late) reload with the query
  // shown now, not the one they were created with (R17-01).
  const latestLoad = useRef(load)
  useEffect(() => {
    latestLoad.current = load
  }, [load])
  const reload = useCallback(() => latestLoad.current(), [])

  useEffect(load, [load])
  const poll = useCallback(() => {
    if (inFlight.current?.query === shown.current) return
    load()
  }, [load])
  usePolling(poll, pollMs)

  return { data, error, setError, reload }
}
