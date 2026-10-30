// The saved-pass store: retention deadlines apply to cached lists too (R15-01),
// snapshots are stable, and malformed entries are ignored.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetPass, loadPasses, savePass, useStoredPasses, type StoredPass } from './passStorage'

const KEY = 'passsystem.passes.v1'
const pass = (token: string, startsAt: string): StoredPass => ({
  token,
  slug: 'gala',
  eventName: 'Gala',
  attendeeName: 'Ana Test',
  startsAt,
  savedAt: '2029-12-01T00:00:00Z',
})

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useStoredPasses retention (R15-01)', () => {
  it('a list opened after the deadline does not show the expired pass (Codex schedule)', () => {
    localStorage.setItem(KEY, JSON.stringify([pass('A', '2030-01-01T00:00:00Z')]))
    vi.setSystemTime(new Date('2030-01-03T23:59:59Z'))
    const first = renderHook(() => useStoredPasses())
    expect(first.result.current.map((p) => p.token)).toEqual(['A'])
    first.unmount()

    vi.setSystemTime(new Date('2030-01-04T00:00:01Z')) // three days after the start
    expect(loadPasses()).toEqual([])
    const second = renderHook(() => useStoredPasses())
    expect(second.result.current).toEqual([])
  })

  it('a list already open drops the pass when its deadline passes', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([pass('A', '2030-01-01T00:00:00Z'), pass('B', '2030-02-01T00:00:00Z')]),
    )
    vi.setSystemTime(new Date('2030-01-03T23:59:00Z'))
    const { result } = renderHook(() => useStoredPasses())
    expect(result.current.map((p) => p.token)).toEqual(['A', 'B'])

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // past A's deadline, before B's
    })
    expect(result.current.map((p) => p.token)).toEqual(['B'])
  })

  it('keeps the same array while nothing changed, and a new one after a save', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    localStorage.setItem(KEY, JSON.stringify([pass('A', '2030-01-02T00:00:00Z')]))
    const { result, rerender } = renderHook(() => useStoredPasses())
    const before = result.current
    rerender()
    expect(result.current).toBe(before)

    act(() => savePass(pass('C', '2030-01-02T00:00:00Z')))
    expect(result.current).not.toBe(before)
    expect(result.current.map((p) => p.token)).toEqual(['C', 'A'])
  })
})

describe('useStoredPasses after the clock jumps (R16-03)', () => {
  it('rechecks deadlines when the tab becomes visible or focused', () => {
    localStorage.setItem(KEY, JSON.stringify([pass('A', '2030-01-01T00:00:00Z')]))
    vi.setSystemTime(new Date('2030-01-03T23:00:00Z')) // an hour before A expires
    const { result } = renderHook(() => useStoredPasses())
    expect(result.current.map((p) => p.token)).toEqual(['A'])

    // The wall clock moves two hours ahead without that time elapsing for timers.
    vi.setSystemTime(new Date('2030-01-04T01:00:00Z'))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toEqual([])
  })

  it('keeps the same array on focus when nothing expired', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    localStorage.setItem(KEY, JSON.stringify([pass('A', '2030-01-02T00:00:00Z')]))
    const { result } = renderHook(() => useStoredPasses())
    const before = result.current
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current).toBe(before)
  })
})

describe('loadPasses', () => {
  it('ignores entries whose fields are not all strings, and non-array or broken JSON', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const good = pass('A', '2030-01-02T00:00:00Z')
    localStorage.setItem(
      KEY,
      JSON.stringify([good, { ...good, token: 'B', eventName: { x: 1 } }, { token: 'C' }, null, 'D']),
    )
    expect(loadPasses().map((p) => p.token)).toEqual(['A'])
    localStorage.setItem(KEY, '{"not":"a list"}')
    expect(loadPasses()).toEqual([])
    localStorage.setItem(KEY, '[{"broken"')
    expect(loadPasses()).toEqual([])
  })
})

// Original tests, on the real clock.
describe('passStorage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })
  const fresh = (token: string, startsAt: string) => ({
    ...pass(token, startsAt),
    savedAt: new Date().toISOString(),
  })
  it('keeps upcoming passes and drops passes for events long over', () => {
    savePass(fresh('A'.repeat(24), new Date(Date.now() + 86_400_000).toISOString()))
    savePass(fresh('B'.repeat(24), new Date(Date.now() - 10 * 86_400_000).toISOString()))
    expect(loadPasses().map((p) => p.token)).toEqual(['A'.repeat(24)])
  })
  it('forgets a pass on request', () => {
    savePass(fresh('A'.repeat(24), new Date(Date.now() + 86_400_000).toISOString()))
    forgetPass('A'.repeat(24))
    expect(loadPasses()).toEqual([])
  })
})
