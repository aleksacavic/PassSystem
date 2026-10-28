import { describe, expect, it } from 'vitest'
import { ScanGate } from './scanGate'

describe('ScanGate', () => {
  it('blocks new detections while a request is in flight', () => {
    const g = new ScanGate(3000)
    expect(g.accept('A', 0)).toBe(true)
    g.begin('A', 0)
    expect(g.accept('B', 100)).toBe(false)
    g.end('A', 200)
    expect(g.accept('B', 300)).toBe(true)
  })
  it('suppresses the same credential while it stays in view', () => {
    const g = new ScanGate(3000)
    g.begin('A', 0)
    g.end('A', 100)
    // Camera keeps seeing A every 120 ms for 10 s: never resubmitted.
    for (let t = 200; t < 10_000; t += 120) expect(g.accept('A', t)).toBe(false)
    // Out of view for > cooldown: allowed again.
    expect(g.accept('A', 10_000 + 3001)).toBe(true)
  })
  it('allows a different credential immediately', () => {
    const g = new ScanGate(3000)
    g.begin('A', 0)
    g.end('A', 50)
    expect(g.accept('B', 60)).toBe(true)
  })
  it('reset allows manual retry', () => {
    const g = new ScanGate(3000)
    g.begin('A', 0)
    g.end('A', 50)
    g.reset()
    expect(g.accept('A', 60)).toBe(true)
  })
})
