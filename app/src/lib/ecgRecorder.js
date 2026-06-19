/**
 * EcgRecorder — accumulates ECG samples from Polar H10 PMD stream.
 *
 * Two buffers:
 *   _all   : complete recording (every µV sample), kept for upload
 *   _ring  : circular buffer of the last N_DISPLAY samples, read by EcgCanvas
 *
 * 5-min session @ 130 Hz = ~39,000 samples ≈ 156 KB as Int32Array.
 * Ring buffer (650 samples) is never resized — safe to read concurrently with RAF.
 */

export const N_DISPLAY       = 650   // ~5 s at 130 Hz — canvas visible window
const        SETTLING_SAMPLES = 260  // first 2 s before signal stabilises

export class EcgRecorder {
  constructor() {
    this.reset()
  }

  reset() {
    this._all      = []
    this._ring     = new Float32Array(N_DISPLAY)
    this._head     = 0   // next write position in ring
    this._count    = 0   // total samples received
  }

  addSamples(µVArray) {
    for (let i = 0; i < µVArray.length; i++) {
      const v = µVArray[i]
      this._all.push(v)
      this._ring[this._head] = v
      this._head = (this._head + 1) % N_DISPLAY
      this._count++
    }
  }

  /**
   * Returns ordered slice of the ring buffer (oldest → newest) as Float32Array.
   * Allocates a new array on every call — suitable for 60 fps RAF reads.
   */
  getDisplayBuffer() {
    const out = new Float32Array(N_DISPLAY)
    for (let i = 0; i < N_DISPLAY; i++) {
      out[i] = this._ring[(this._head + i) % N_DISPLAY]
    }
    return out
  }

  /** Full recording as a plain JS number array (for upload / offline storage). */
  getAll() { return this._all }

  getSampleCount() { return this._count }

  /** True during the first 2 seconds while the H10 signal is settling. */
  isSettling() { return this._count < SETTLING_SAMPLES }
}
