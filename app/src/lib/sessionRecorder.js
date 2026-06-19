import { computeSessionMetrics, liveMetrics } from './hrvCalc.js'

/**
 * Manages the recording state for a single HRV session.
 * Keeps accumulated RR intervals and pushes live metrics to a listener
 * on every beat and once per second via an interval.
 */
export class SessionRecorder {
  constructor(onUpdate) {
    this._rr           = []
    this._startTs      = null
    this._timerInterval = null
    this._onUpdate     = onUpdate  // ({ elapsed_s, n_rr, live_metrics }) => void
  }

  start() {
    this._rr      = []
    this._startTs = Date.now()
    this._timerInterval = setInterval(() => {
      this._onUpdate(this._buildState())
    }, 1000)
  }

  stop() {
    clearInterval(this._timerInterval)
    this._timerInterval = null
  }

  reset() {
    this.stop()
    this._rr      = []
    this._startTs = null
  }

  /** Called by PolarBle on each HRM notification */
  addBeat(rrArray, _hrBpm) {
    for (const rr of rrArray) this._rr.push(rr)
    this._onUpdate(this._buildState())
  }

  getRrIntervals() { return [...this._rr] }
  getMetrics()     { return computeSessionMetrics(this._rr) }
  getDurationS()   { return this._startTs ? Math.floor((Date.now() - this._startTs) / 1000) : 0 }

  _buildState() {
    return {
      elapsed_s:    this.getDurationS(),
      n_rr:         this._rr.length,
      live_metrics: liveMetrics(this._rr),
    }
  }
}
