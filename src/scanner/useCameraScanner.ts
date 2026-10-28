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
    if (videoRef.current) videoRef.current.srcObject = null
    setTorchOn(false)
    setTorchSupported(false)
  }, [])

  // Decode loop: one detection at a time, then wait `intervalMs`.
  const loopRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    loopRef.current = () => {
      if (!runningRef.current) return
      const video = videoRef.current
      const detector = detectorRef.current
      const next = () => {
        if (runningRef.current) timerRef.current = window.setTimeout(() => loopRef.current(), intervalMs)
      }
      if (!video || !detector || video.readyState < 2 || video.videoWidth === 0) return next()
      detector
        .detect(video)
        .then((values) => {
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
      setStatus('starting')
      stopTracks()
      try {
        const [detector, stream] = await Promise.all([
          getQrDetector(),
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: deviceId
              ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
              : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          }),
        ])
        detectorRef.current = detector
        setDetectorKind(detector.kind)
        streamRef.current = stream
        const video = videoRef.current
        if (!video) throw new Error('Video element missing')
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        video.muted = true
        await video.play().catch(() => undefined)

        const track = stream.getVideoTracks()[0]
        const caps = (track?.getCapabilities?.() ?? {}) as TorchCapabilities
        setTorchSupported(Boolean(caps.torch))
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          setCameraCount(devices.filter((d) => d.kind === 'videoinput').length)
        } catch {
          setCameraCount(1)
        }
        runningRef.current = true
        setStatus('running')
        loopRef.current()
      } catch (e) {
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
      }
    },
    [stopTracks],
  )

  const stop = useCallback(() => {
    runningRef.current = false
    resumeOnVisibleRef.current = false
    stopTracks()
    setStatus('idle')
  }, [stopTracks])

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch {
      setTorchSupported(false)
    }
  }, [torchOn])

  const switchCamera = useCallback(async () => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
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
      if (document.visibilityState === 'hidden' && runningRef.current) {
        resumeOnVisibleRef.current = true
        runningRef.current = false
        stopTracks()
        setStatus('idle')
      } else if (document.visibilityState === 'visible' && resumeOnVisibleRef.current) {
        resumeOnVisibleRef.current = false
        void start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [start, stopTracks])

  useEffect(
    () => () => {
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
