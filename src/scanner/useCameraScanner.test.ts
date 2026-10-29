// The camera must be released whichever way a start ends (F-14, R4-02, R5-02).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getQrDetector } from './detector'
import { useCameraScanner } from './useCameraScanner'

vi.mock('./detector', () => ({ getQrDetector: vi.fn() }))

type Detector = Awaited<ReturnType<typeof getQrDetector>>

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

const fakeDetector = { kind: 'native', detect: async () => [] } as unknown as Detector
const flush = () => act(async () => {})

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

let camera: ReturnType<typeof deferred<MediaStream>>
let detector: ReturnType<typeof deferred<Detector>>
let cameras: ReturnType<typeof deferred<MediaDeviceInfo[]>>

beforeEach(() => {
  camera = deferred<MediaStream>()
  detector = deferred<Detector>()
  cameras = deferred<MediaDeviceInfo[]>()
  vi.mocked(getQrDetector).mockImplementation(() => detector.promise)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => camera.promise), enumerateDevices: vi.fn(() => cameras.promise) },
  })
})

afterEach(() => {
  vi.mocked(getQrDetector).mockReset()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

/** The hook with a mounted video element, as on the scanner page. */
function mountScanner() {
  const view = renderHook(() => useCameraScanner({ onDetect: () => undefined }))
  const video = { srcObject: null, muted: false, setAttribute: () => undefined, play: async () => undefined }
  ;(view.result.current.videoRef as { current: unknown }).current = video
  let started: Promise<void> = Promise.resolve()
  const start = () =>
    act(() => {
      started = view.result.current.start()
    })
  return { ...view, start, started: () => act(() => started) }
}

describe('useCameraScanner releases the camera', () => {
  it('when the detector fails before the camera answers', async () => {
    const { result, unmount, start, started } = mountScanner()
    start()
    detector.reject(new Error('wasm failed to load'))
    await started()
    expect(result.current.status).toBe('error')
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await flush()
    expect(track.stop).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('when the camera answers before the detector fails', async () => {
    const { start, started } = mountScanner()
    start()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await flush()
    detector.reject(new Error('wasm failed to load'))
    await started()
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('on Stop while the detector is still loading, without waiting for it', async () => {
    const { result, start } = mountScanner()
    start()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await flush()
    act(() => result.current.stop())
    expect(track.stop).toHaveBeenCalledTimes(1) // the detector never settled
    expect(result.current.status).toBe('idle')
  })

  it('when the page is hidden during startup, and does not start running', async () => {
    const { result, start, started } = mountScanner()
    start()
    act(() => setVisibility('hidden'))
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    detector.resolve(fakeDetector)
    cameras.resolve([])
    await started()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })

  it('on Stop while the camera list is loading, and stays stopped', async () => {
    const { result, start, started } = mountScanner()
    start()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    detector.resolve(fakeDetector)
    await flush()
    act(() => result.current.stop())
    cameras.resolve([])
    await started()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
  })

  it('of an older start when a newer one takes over', async () => {
    const first = deferred<MediaStream>()
    const second = deferred<MediaStream>()
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { result } = mountScanner()
    let a!: Promise<void>, b!: Promise<void>
    act(() => {
      a = result.current.start()
    })
    act(() => {
      b = result.current.start()
    })
    const older = fakeStream()
    const newer = fakeStream()
    second.resolve(newer.stream)
    first.resolve(older.stream)
    detector.resolve(fakeDetector)
    cameras.resolve([])
    await act(() => Promise.all([a, b]))
    expect(older.track.stop).toHaveBeenCalledTimes(1)
    expect(newer.track.stop).not.toHaveBeenCalled()
    expect(result.current.status).toBe('running')
  })

  it('when the page goes away while the camera list is loading', async () => {
    const { unmount, start } = mountScanner()
    start()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    detector.resolve(fakeDetector)
    await flush()
    unmount()
    expect(track.stop).toHaveBeenCalledTimes(1)
    cameras.resolve([])
    await new Promise((r) => setTimeout(r, 0))
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('when the page goes away before the camera answers, as soon as it does', async () => {
    const { unmount, start } = mountScanner()
    start()
    unmount()
    const { stream, track } = fakeStream()
    camera.resolve(stream)
    await new Promise((r) => setTimeout(r, 0))
    expect(track.stop).toHaveBeenCalledTimes(1) // the detector is still loading
  })
})
