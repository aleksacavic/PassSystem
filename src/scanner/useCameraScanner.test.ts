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

describe('a camera switch that finishes late does not restart the camera (R6-01)', () => {
  // Start successfully with two cameras, then begin a switch whose camera list is still loading.
  async function runningWithPendingSwitch() {
    const scanner = mountScanner()
    const firstStream = fakeStream()
    const listing = deferred<MediaDeviceInfo[]>()
    const second = deferred<MediaStream>()
    const two = [
      { kind: 'videoinput', deviceId: 'back' },
      { kind: 'videoinput', deviceId: 'front' },
    ] as MediaDeviceInfo[]
    vi.mocked(navigator.mediaDevices.enumerateDevices)
      .mockImplementationOnce(async () => two) // during start
      .mockImplementationOnce(() => listing.promise) // during the switch
      .mockImplementation(async () => two) // any later start
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockImplementationOnce(async () => firstStream.stream)
      .mockImplementationOnce(() => second.promise)
    detector.resolve(fakeDetector)
    scanner.start()
    await scanner.started()
    expect(scanner.result.current.status).toBe('running')
    let switching!: Promise<void>
    act(() => {
      switching = scanner.result.current.switchCamera()
    })
    const finishSwitch = async () => {
      listing.resolve(two)
      const late = fakeStream()
      second.resolve(late.stream)
      await act(() => switching)
      await flush()
      return late
    }
    return { ...scanner, finishSwitch }
  }

  it('after Stop', async () => {
    const { result, finishSwitch } = await runningWithPendingSwitch()
    act(() => result.current.stop())
    const late = await finishSwitch()
    expect(result.current.status).toBe('idle')
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1) // no new camera request
    expect(late.track.stop).not.toHaveBeenCalled() // it was never opened
  })

  it('after the page is hidden', async () => {
    const { result, finishSwitch } = await runningWithPendingSwitch()
    act(() => setVisibility('hidden'))
    await finishSwitch()
    expect(result.current.status).toBe('idle')
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('after the page goes away', async () => {
    const { unmount, finishSwitch } = await runningWithPendingSwitch()
    unmount()
    await finishSwitch()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('when a second switch overtakes it, only one new camera is opened', async () => {
    const scanner = mountScanner()
    const two = [
      { kind: 'videoinput', deviceId: 'back' },
      { kind: 'videoinput', deviceId: 'front' },
    ] as MediaDeviceInfo[]
    const firstList = deferred<MediaDeviceInfo[]>()
    const secondList = deferred<MediaDeviceInfo[]>()
    vi.mocked(navigator.mediaDevices.enumerateDevices)
      .mockImplementationOnce(async () => two)
      .mockImplementationOnce(() => firstList.promise)
      .mockImplementationOnce(() => secondList.promise)
      .mockImplementation(async () => two)
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => fakeStream().stream)
    detector.resolve(fakeDetector)
    scanner.start()
    await scanner.started()
    let a!: Promise<void>, b!: Promise<void>
    act(() => {
      a = scanner.result.current.switchCamera()
      b = scanner.result.current.switchCamera()
    })
    secondList.resolve(two) // the later switch wins and starts the new camera
    await act(() => b)
    firstList.resolve(two)
    await act(() => a)
    await flush()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2) // initial start + one switch
    expect(scanner.result.current.status).toBe('running')
  })
})

describe('callbacks that finish after the camera was stopped change nothing (R7-01, R7-02)', () => {
  const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ01'

  function torchStream() {
    const constraints = deferred<void>()
    const track = {
      stop: vi.fn(),
      getSettings: () => ({}),
      getCapabilities: () => ({ torch: true }),
      applyConstraints: vi.fn(() => constraints.promise),
    }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
    return { stream, track, constraints }
  }

  /** Running scanner whose first decode is still in progress. */
  async function decoding() {
    const onDetect = vi.fn()
    const decode = deferred<string[]>()
    const detect = vi
      .fn()
      .mockImplementationOnce(() => decode.promise)
      .mockImplementation(() => new Promise(() => {}))
    const view = renderHook(() => useCameraScanner({ onDetect }))
    const video = {
      srcObject: null,
      muted: false,
      readyState: 4,
      videoWidth: 640,
      setAttribute: () => undefined,
      play: async () => undefined,
    }
    ;(view.result.current.videoRef as { current: unknown }).current = video
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => fakeStream().stream)
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockImplementation(async () => [])
    detector.resolve({ kind: 'native', detect } as unknown as Detector)
    await act(() => view.result.current.start())
    expect(view.result.current.status).toBe('running')
    expect(detect).toHaveBeenCalledTimes(1)
    const finishDecode = async () => {
      decode.resolve([TOKEN])
      await flush()
    }
    return { ...view, onDetect, detect, finishDecode }
  }

  it('a decode that finishes after Stop delivers no pass', async () => {
    const { result, onDetect, detect, finishDecode } = await decoding()
    act(() => result.current.stop())
    await finishDecode()
    expect(onDetect).not.toHaveBeenCalled()
    expect(detect).toHaveBeenCalledTimes(1) // and no further decode was scheduled
  })

  it('a decode that finishes after the page was hidden delivers no pass', async () => {
    const { onDetect, finishDecode } = await decoding()
    act(() => setVisibility('hidden'))
    await finishDecode()
    expect(onDetect).not.toHaveBeenCalled()
  })

  it('a decode that finishes after unmount delivers no pass', async () => {
    const { unmount, onDetect, finishDecode } = await decoding()
    unmount()
    await finishDecode()
    expect(onDetect).not.toHaveBeenCalled()
  })

  it("an old start's decode delivers nothing to the camera that replaced it", async () => {
    const { result, onDetect, detect, finishDecode } = await decoding()
    await act(() => result.current.start()) // replacement camera, its own decode starts
    expect(detect).toHaveBeenCalledTimes(2)
    await finishDecode()
    expect(onDetect).not.toHaveBeenCalled()
  })

  it('a torch change that finishes after Stop leaves the torch off', async () => {
    const { result, start, started } = mountScanner()
    const torch = torchStream()
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(async () => torch.stream)
    detector.resolve(fakeDetector)
    cameras.resolve([])
    start()
    await started()
    expect(result.current.torchSupported).toBe(true)
    let toggling!: Promise<void>
    act(() => {
      toggling = result.current.toggleTorch()
    })
    act(() => result.current.stop())
    torch.constraints.resolve()
    await act(() => toggling)
    expect(result.current.torchOn).toBe(false)
  })

  it("a torch failure on the old camera does not disable the new camera's torch", async () => {
    const { result, start, started } = mountScanner()
    const first = torchStream()
    const second = torchStream()
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockImplementationOnce(async () => first.stream)
      .mockImplementationOnce(async () => second.stream)
    detector.resolve(fakeDetector)
    cameras.resolve([])
    start()
    await started()
    let toggling!: Promise<void>
    act(() => {
      toggling = result.current.toggleTorch()
    })
    await act(() => result.current.start()) // replaced by the second camera
    expect(result.current.torchSupported).toBe(true)
    first.constraints.reject(new Error('torch failed'))
    await act(() => toggling)
    expect(result.current.torchSupported).toBe(true)
    expect(result.current.torchOn).toBe(false)
  })
})
