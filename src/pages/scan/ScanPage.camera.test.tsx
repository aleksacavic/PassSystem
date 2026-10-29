// The real scanner page with the real camera hook: a decode still in progress
// when the operator presses Stop must not send an admission (R7-01).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ admitPass: vi.fn(), getEventSummaries: vi.fn() }))
const scan = vi.hoisted(() => ({ detect: vi.fn() }))
vi.mock('../../lib/api', () => api)
vi.mock('../../scanner/detector', () => ({
  getQrDetector: async () => ({ kind: 'native', detect: scan.detect }),
}))
vi.mock('../../scanner/useWakeLock', () => ({ useWakeLock: () => undefined }))
vi.mock('../../scanner/feedback', () => ({ feedback: vi.fn(), unlockAudio: vi.fn() }))
import ScanPage from './ScanPage'

const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ01'
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

let decode: { resolve: (v: string[]) => void }
const restore: (() => void)[] = []
function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, ...descriptor })
  restore.push(() =>
    previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key],
  )
}

beforeEach(() => {
  api.admitPass.mockReset().mockResolvedValue({ kind: 'error', message: 'not reached in these tests' })
  api.getEventSummaries.mockReset().mockImplementation(async (id: string) => [
    {
      id,
      name: `Event ${id}`,
      slug: id,
      status: 'published',
      starts_at: '2026-11-01T18:00:00Z',
      ends_at: null,
      location: null,
      timezone: 'Europe/Belgrade',
      max_attendees: null,
      my_role: 'operator',
      registered_count: 10,
      checked_in_count: 0,
      revoked_count: 0,
    },
  ])
  scan.detect.mockReset().mockImplementationOnce(
    () =>
      new Promise<string[]>((resolve) => {
        decode = { resolve }
      }),
  )
  scan.detect.mockImplementation(() => new Promise(() => {}))
  const track = { stop: vi.fn(), getSettings: () => ({}), getCapabilities: () => ({}) }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  stub(window, 'isSecureContext', { value: true })
  stub(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []) },
  })
  // jsdom has no media playback: a playing video with a frame ready.
  stub(HTMLMediaElement.prototype, 'play', { value: async () => undefined })
  stub(HTMLMediaElement.prototype, 'readyState', { get: () => 4 })
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 640 })
})

afterEach(() => {
  while (restore.length) restore.pop()!()
})

async function scannerWithDecodeInProgress() {
  render(
    <MemoryRouter initialEntries={['/scan/A']}>
      <Routes>
        <Route path="/scan/:eventId" element={<ScanPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await flush()
  fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
  await flush()
  expect(scan.detect).toHaveBeenCalledTimes(1)
}

describe('ScanPage with the real camera hook', () => {
  it('a decode that finishes after Stop sends no admission', async () => {
    await scannerWithDecodeInProgress()
    fireEvent.click(screen.getByRole('button', { name: /Stop camera/ }))
    await flush()
    decode.resolve([TOKEN])
    await flush()
    expect(api.admitPass).not.toHaveBeenCalled()
  })

  it('the same decode is admitted while the camera is still running (control)', async () => {
    await scannerWithDecodeInProgress()
    decode.resolve([TOKEN])
    await flush()
    expect(api.admitPass).toHaveBeenCalledWith('A', TOKEN, expect.any(String))
  })
})
