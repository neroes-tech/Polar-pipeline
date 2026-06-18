import { computeSessionMetrics, liveLnRmssd } from './hrvCalc.js'

/**
 * Manages the recording state for a single HRV session.
 * Keeps accumulated RR intervals and updates a listener on each new beat.
 */
export class SessionRecorder {
  constructor(onUpdate) {
    this._rr = []
    this._startTs = null
    this._timerInterval = null
    this._onUpdate = onUpdate  // called with { elapsed_s, n_rr, live_lnrmssd, hr_bpm }
  }

  start() {
    this._rr = []
    this._startTs = Date.now()
    this._timerInterval = setInterval(() => {
      this._onUpdate(this._buildState(null))
    }, 1000)
  }

  stop() {
    clearInterval(this._timerInterval)
    this._timerInterval = null
  }

  reset() {
    this.stop()
    this._rr = []
    this._startTs = null
  }

  /** Called by polarBle on each HRM notification */
  addBeat(rrArray, hrBpm) {
    for (const rr of rrArray) {
      this._rr.push(rr)
    }
    this._onUpdate(this._buildState(hrBpm))
  }

  getRrIntervals() {
    return [...this._rr]
  }

  getMetrics() {
    return computeSessionMetrics(this._rr)
  }

  getDurationS() {
    if (!this._startTs) return 0
    return Math.floor((Date.now() - this._startTs) / 1000)
  }

  _buildState(hrBpm) {
    return {
      elapsed_s: this.getDurationS(),
      n_rr: this._rr.length,
      live_lnrmssd: liveLnRmssd(this._rr),
      hr_bpm: hrBpm,
    }
  }
}
