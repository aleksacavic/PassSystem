/**
 * Decides which camera detections are submitted to the server.
 *
 * - Only one validation request is in flight at a time.
 * - A credential that was just handled is ignored while it stays in view: every
 *   sighting extends the quiet period, so holding a pass in front of the camera
 *   never produces repeated backend requests. Once it has been out of view for
 *   `cooldownMs`, scanning it again is allowed (and yields "already used").
 */
export class ScanGate {
  private busy = false
  private last: { key: string; seenAt: number } | null = null

  constructor(private readonly cooldownMs = 3000) {}

  /** Returns true if a detection of `key` at time `now` should be processed. */
  accept(key: string, now: number): boolean {
    if (this.last && this.last.key === key && now - this.last.seenAt < this.cooldownMs) {
      this.last.seenAt = now
      return false
    }
    if (this.busy) return false
    return true
  }

  begin(key: string, now: number): void {
    this.busy = true
    this.last = { key, seenAt: now }
  }

  end(key: string, now: number): void {
    this.busy = false
    this.last = { key, seenAt: now }
  }

  get inFlight(): boolean {
    return this.busy
  }

  /** Forget the last credential so it can be submitted again immediately (manual retry). */
  reset(): void {
    this.last = null
  }
}
