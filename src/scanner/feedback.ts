/** Audible + haptic feedback for scan results. Silent if unsupported. */
let ctx: AudioContext | null = null

/** Must be called from a user gesture (e.g. "Start camera") to unlock audio on iOS. */
export function unlockAudio() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    ctx ??= new Ctor()
    void ctx.resume()
  } catch {
    ctx = null
  }
}

function tone(freq: number, startAt: number, duration: number) {
  if (!ctx) return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(0.3, startAt + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.02)
}

export function feedback(kind: 'ok' | 'bad' | 'warn', soundOn: boolean) {
  try {
    navigator.vibrate?.(kind === 'ok' ? 120 : kind === 'bad' ? [220, 90, 220] : [80, 60, 80])
  } catch {
    /* ignore */
  }
  if (!soundOn || !ctx) return
  const t = ctx.currentTime
  if (kind === 'ok') {
    tone(880, t, 0.12)
    tone(1320, t + 0.12, 0.16)
  } else if (kind === 'bad') {
    tone(220, t, 0.22)
    tone(180, t + 0.28, 0.3)
  } else {
    tone(440, t, 0.15)
  }
}
