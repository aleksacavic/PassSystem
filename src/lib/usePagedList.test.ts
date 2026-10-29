// The paged-list loader shared by the Registrations and Scan activity tabs (R18-02).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePagedList } from './usePagedList'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

describe('usePagedList', () => {
  it('a network slower than the poll interval still shows the list', async () => {
    let calls = 0
    const fetch = vi.fn(() => after(16_000, `rows ${++calls}`)) // every response takes 16 s
    const { result } = renderHook(() => usePagedList('q', fetch, 15_000))
    expect(result.current.data).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_500)
    })
    expect(result.current.data).toBe('rows 1') // was discarded as soon as the 15 s poll had started

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(result.current.data).toMatch(/^rows \d+$/)
    // Polls are skipped while a request for the same list is on its way: no pile-up.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('an older response that arrives after a newer one is ignored', async () => {
    const responses: ((v: string) => void)[] = []
    const fetch = vi.fn(() => new Promise<string>((r) => responses.push(r)))
    const { result, rerender } = renderHook(({ q }) => usePagedList(q, fetch, 15_000), {
      initialProps: { q: 'page 1' },
    })
    rerender({ q: 'page 2' })
    rerender({ q: 'page 1' }) // back to page 1: a third request
    await act(async () => responses[2]!('page 1, fresh'))
    expect(result.current.data).toBe('page 1, fresh')
    await act(async () => responses[0]!('page 1, old')) // the first request finishes last
    await act(async () => responses[1]!('page 2'))
    expect(result.current.data).toBe('page 1, fresh')
  })

  it('reload() from an old callback loads the query shown now', async () => {
    const fetchFor = (q: string) => vi.fn(async () => q)
    const first = fetchFor('alice')
    const second = fetchFor('everyone')
    const { result, rerender } = renderHook(({ q, f }) => usePagedList(q, f, 15_000), {
      initialProps: { q: 'alice', f: first },
    })
    const oldReload = result.current.reload
    rerender({ q: 'everyone', f: second })
    await act(async () => {})
    await act(async () => oldReload())
    expect(second).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(result.current.data).toBe('everyone')
  })
})
