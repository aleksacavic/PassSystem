import { useCallback, useEffect, useRef, useState } from 'react'
import { getQrDetector, type QrDetector } from './detector'

export type CameraStatus =
  'idle' | 'starting' | 'running' | 'denied' | 'unavailable' | 'unsupported' | 'error'

interface Options {
  onDetect: (rawValue: string) => void
  /** Delay between decode attempts. */
  intervalMs?: number
}

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean }

/**
 * Camera + QR decoding loop for the door scanner.
 * Prefers the rear camera, supports torch where the browser exposes it, and
 * releases the camera when the page is hidden.
 */
export function useCameraScanner({ onDetect, intervalMs = 120 }: Options) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<QrDetector | null>(null)
  const timerRef = useRef<number | null>(null)
  const runningRef = useRef(false)
  const resumeOnVisibleRef = useRef(false)
  const onDetectRef = useRef(onDetect)
  const deviceIndexRef = useRef(0)
  // Camera chosen with "Switch camera", reused when resuming after the page was hidden.
  const deviceIdRef = useRef<string | undefined>(undefined)
  // Bumped by every start, stop, hide, failure and unmount: a start whose
  // generation is no longer current stops at its next step and touches nothing.
  const generationRef = useRef(0)
  // Generation of the start still in progress (0: none), so hiding the page
  // cancels it too.
  const startingRef = useRef(0)
  // Streams a start obtained that are not the active stream yet. Stopped with
  // the active one, so a stream is released even while the detector is loading.
  const pendingRef = useRef(new Set<MediaStream>())
  const [status, setStatus] = useState<CameraStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [cameraCount, setCameraCount] = useState(0)
  const [detectorKind, setDetectorKind] = useState<QrDetector['kind'] | null>(null)

  useEffect(() => {
    onDetectRef.current = onDetect
  }, [onDetect])

  const stopTracks = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    pendingRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    pendingRef.current.clear()
    if (videoRef.current) videoRef.current.srcObject = null
    setTorchOn(false)
    setTorchSupported(false)
  }, [])

  // Decode loop: one detection at a time, then wait `intervalMs`. Each loop
  // belongs to the start (generation) that began it: once that start is
  // stopped, hidden, unmounted or replaced, a decode still in progress
  // delivers nothing and schedules nothing.
  const loopRef = useRef<(generation: number) => void>(() => undefined)
  useEffect(() => {
    loopRef.current = (generation) => {
      const live = () => runningRef.current && generation === generationRef.current
      if (!live()) return
      const video = videoRef.current
      const detector = detectorRef.current
      const next = () => {
        if (live()) timerRef.current = window.setTimeout(() => loopRef.current(generation), intervalMs)
      }
      if (!video || !detector || video.readyState < 2 || video.videoWidth === 0) return next()
      detector
        .detect(video)
        .then((values) => {
          if (!live()) return
          for (const v of values) if (v) onDetectRef.current(v)
        })
        .catch(() => undefined)
        .finally(next)
    }
  }, [intervalMs])

  const start = useCallback(
    async (deviceId?: string) => {
      setError(null)
      if (!window.isSecureContext) {
        setStatus('unsupported')
        setError('The camera requires a secure (HTTPS) connection.')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported')
        setError('This browser does not support camera access. Use manual entry below.')
        return
      }
      const generation = ++generationRef.current
      const current = () => generation === generationRef.current
      startingRef.current = generation
      setStatus('starting')
      stopTracks()
      const media = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      // Registered before anything else waits on `media`: the stream is tracked
      // (or, for a cancelled start, stopped) the moment the camera answers.
      media.then(
        (s) => {
          if (current()) pendingRef.current.add(s)
          else s.getTracks().forEach((t) => t.stop())
        },
        () => undefined,
      )
      try {
        const [detector, stream] = await Promise.all([getQrDetector(), media])
        if (!current()) return
        pendingRef.current.delete(stream)
        streamRef.current = stream
        detectorRef.current = detector
        setDetectorKind(detector.kind)
        const video = videoRef.current
        if (!video) throw new Error('Video element missing')
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        video.muted = true
        await video.play().catch(() => undefined)
        if (!current()) return
        deviceIdRef.current = deviceId ?? stream.getVideoTracks()[0]?.getSettings().deviceId

        const track = stream.getVideoTracks()[0]
        const caps = (track?.getCapabilities?.() ?? {}) as TorchCapabilities
        setTorchSupported(Boolean(caps.torch))
        let cameras = 1
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          cameras = devices.filter((d) => d.kind === 'videoinput').length
        } catch {
          /* keep 1 */
        }
        if (!current()) return
        setCameraCount(cameras)
        runningRef.current = true
        setStatus('running')
        loopRef.current(generation)
      } catch (e) {
        if (!current()) return
        // A camera that answers after this failure is then stopped straight away.
        generationRef.current++
        stopTracks()
        runningRef.current = false
        const name = (e as DOMException)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('denied')
          setError(
            'Camera permission was denied. Allow camera access in your browser settings, then tap Start camera.',
          )
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setStatus('unavailable')
          setError('No camera was found on this device. Use manual entry below.')
        } else if (name === 'NotReadableError' || name === 'AbortError') {
          setStatus('error')
          setError(
            'The camera is in use by another app or could not be started. Close other camera apps and try again.',
          )
        } else {
          setStatus('error')
          setError('Could not start the camera scanner. Use manual entry below or reload the page.')
        }
      } finally {
        if (startingRef.current === generation) startingRef.current = 0
      }
    },
    [stopTracks],
  )

  const stop = useCallback(() => {
    generationRef.current++
    startingRef.current = 0
    runningRef.current = false
    resumeOnVisibleRef.current = false
    stopTracks()
    setStatus('idle')
  }, [stopTracks])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const generation = generationRef.current
    // Only for the same camera: a stop or a new start meanwhile has reset the torch state.
    const current = () =>
      generation === generationRef.current && streamRef.current?.getVideoTracks()[0] === track
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      if (current()) setTorchOn(next)
    } catch {
      if (current()) setTorchSupported(false)
    }
  }, [torchOn])

  const switchCamera = useCallback(async () => {
    // A Stop, hide, unmount or newer start while the camera list loads
    // advances the generation: the switch is then dropped.
    const generation = generationRef.current
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      if (generation !== generationRef.current || document.visibilityState === 'hidden') return
      if (devices.length < 2) return
      const current = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId
      const idx = devices.findIndex((d) => d.deviceId === current)
      deviceIndexRef.current = (idx + 1) % devices.length
      await start(devices[deviceIndexRef.current]?.deviceId)
    } catch {
      /* ignore */
    }
  }, [start])

  // Release the camera while hidden; resume when visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && (runningRef.current || startingRef.current)) {
        generationRef.current++
        startingRef.current = 0
        resumeOnVisibleRef.current = true
        runningRef.current = false
        stopTracks()
        setStatus('idle')
      } else if (document.visibilityState === 'visible' && resumeOnVisibleRef.current) {
        resumeOnVisibleRef.current = false
        void start(deviceIdRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [start, stopTracks])

  useEffect(
    () => () => {
      generationRef.current++
      startingRef.current = 0
      runningRef.current = false
      stopTracks()
    },
    [stopTracks],
  )

  return {
    videoRef,
    status,
    error,
    start,
    stop,
    torchSupported,
    torchOn,
    toggleTorch,
    cameraCount,
    switchCamera,
    detectorKind,
  }
}
