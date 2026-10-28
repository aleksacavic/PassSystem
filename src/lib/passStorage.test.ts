import { beforeEach, describe, expect, it } from 'vitest'
import { forgetPass, loadPasses, savePass, type StoredPass } from './passStorage'

const pass = (token: string, startsAt: string): StoredPass => ({
  token,
  slug: 'gala',
  eventName: 'Gala',
  attendeeName: 'Ana',
  startsAt,
  savedAt: new Date().toISOString(),
})

describe('passStorage', () => {
  beforeEach(() => localStorage.clear())
  it('keeps upcoming passes and drops passes for events long over', () => {
    savePass(pass('A'.repeat(24), new Date(Date.now() + 86_400_000).toISOString()))
    savePass(pass('B'.repeat(24), new Date(Date.now() - 10 * 86_400_000).toISOString()))
    expect(loadPasses().map((p) => p.token)).toEqual(['A'.repeat(24)])
  })
  it('forgets a pass on request', () => {
    savePass(pass('A'.repeat(24), new Date(Date.now() + 86_400_000).toISOString()))
    forgetPass('A'.repeat(24))
    expect(loadPasses()).toEqual([])
  })
})
