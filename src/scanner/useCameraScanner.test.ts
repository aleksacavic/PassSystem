// The camera must be released whichever way a start ends (R4-02, F-14).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getQrDetector } from './detector'
import { useCameraScanner } from './useCameraScanner'

vi.mock('./detector', () => ({ getQrDetector: vi.fn() }))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeStream() {
  const track = { stop: vi.fn(), getSettings: () => ({}), getCapabilities: () => ({}) }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}

const flush = () => act(async () => {})

let camera: ReturnType<typeof deferred<MediaStream>>

beforeEach(() => {
  camera = deferred<MediaStream>()
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => camera.promise), enumerateDevices: vi.fn(async () => []) },
  })
})

afterEach(() => {
  vi.mocked(getQrDetector).mockReset()
})

describe('useCameraScanner releases the camera', () => {
  it('when the detector fails before the camera answers', async () => {
    vi.mocked(getQrDetector).mockRejectedValue(new Error('wasm failed to load'))
    const { result, unmount } = renderHook(() => useCameraScanner({ onDetect: () => undefined }))
    await act(() => result.current.start())
    expect(result.current.status).toBe('error')

    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await flush()
    unmount()
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('when the camera answers before the detector fails', async () => {
    const detector = deferred<never>()
    vi.mocked(getQrDetector).mockReturnValue(detector.promise)
    const { result } = renderHook(() => useCameraScanner({ onDetect: () => undefined }))
    let started!: Promise<void>
    act(() => {
      started = result.current.start()
    })
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await flush()
    detector.reject(new Error('wasm failed to load'))
    await act(() => started)
    await flush()
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('when the page goes away while the start is still in progress', async () => {
    const detector = deferred<Awaited<ReturnType<typeof getQrDetector>>>()
    vi.mocked(getQrDetector).mockReturnValue(detector.promise)
    const { result, unmount } = renderHook(() => useCameraScanner({ onDetect: () => undefined }))
    let started!: Promise<void>
    act(() => {
      started = result.current.start()
    })
    unmount()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    detector.resolve({ kind: 'native', detect: async () => [] } as unknown as Awaited<
      ReturnType<typeof getQrDetector>
    >)
    await started
    await new Promise((r) => setTimeout(r, 0))
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
})
