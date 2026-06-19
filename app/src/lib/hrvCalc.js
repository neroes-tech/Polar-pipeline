const RR_MIN_MS          = 300
const RR_MAX_MS          = 1500
const ECTOPIC_THRESHOLD  = 0.20
const LIVE_WINDOW        = 60   // last N beats for live display

/**
 * Remove out-of-range and ectopic beats.
 */
export function filterArtifacts(rr) {
  const arr = rr.filter(v => v >= RR_MIN_MS && v <= RR_MAX_MS)
  if (arr.length < 2) return arr
  const keep = [true]
  for (let i = 1; i < arr.length; i++) {
    keep.push(Math.abs(arr[i] - arr[i - 1]) / arr[i - 1] <= ECTOPIC_THRESHOLD)
  }
  return arr.filter((_, i) => keep[i])
}

// ── Core metric functions (operate on already-filtered arrays) ────────────────

/** RMSSD and lnRMSSD. Returns null fields when < 2 beats. */
export function computeRmssd(rr) {
  if (rr.length < 2) return { rmssd: null, lnrmssd: null }
  let sumSq = 0
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1]
    sumSq += d * d
  }
  const rmssd = Math.sqrt(sumSq / (rr.length - 1))
  const lnrmssd = rmssd > 0 ? Math.log(rmssd) : null
  return {
    rmssd:   Math.round(rmssd * 10) / 10,
    lnrmssd: lnrmssd !== null ? Math.round(lnrmssd * 1000) / 1000 : null,
  }
}

/** SDNN — sample std deviation of all RR intervals (divide by N-1). */
function computeSDNN(rr) {
  if (rr.length < 2) return null
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length
  const variance = rr.reduce((s, v) => s + (v - mean) ** 2, 0) / (rr.length - 1)
  return Math.round(Math.sqrt(variance) * 10) / 10
}

/** pNN50 — % of successive RR differences > 50 ms. */
function computePnn50(rr) {
  if (rr.length < 2) return null
  let count = 0
  for (let i = 1; i < rr.length; i++) {
    if (Math.abs(rr[i] - rr[i - 1]) > 50) count++
  }
  return Math.round((count / (rr.length - 1)) * 1000) / 10
}

// ── Exported aggregates ───────────────────────────────────────────────────────

/**
 * Live HRV snapshot from the last LIVE_WINDOW beats.
 * Quality is computed over ALL accumulated beats (not just the window).
 * Called ~every second during recording for the live stats display.
 */
export function liveMetrics(rrAll) {
  const n_orig  = rrAll.length
  const allFilt = filterArtifacts(rrAll)
  const quality = n_orig > 0 ? Math.round((allFilt.length / n_orig) * 1000) / 10 : 0

  const win     = rrAll.slice(-LIVE_WINDOW)
  const winFilt = filterArtifacts(win)

  if (winFilt.length < 2) {
    return { lnrmssd: null, rmssd: null, sdnn: null, pnn50: null, mean_rr: null, quality }
  }

  const { rmssd, lnrmssd } = computeRmssd(winFilt)
  const sdnn    = computeSDNN(winFilt)
  const pnn50   = computePnn50(winFilt)
  const mean_rr = Math.round(winFilt.reduce((a, b) => a + b, 0) / winFilt.length)

  return { lnrmssd, rmssd, sdnn, pnn50, mean_rr, quality }
}

/**
 * Full session metrics from all accumulated RR intervals.
 * Called once at the end of a session before upload.
 */
export function computeSessionMetrics(rrAll) {
  const n_orig  = rrAll.length
  const filtered = filterArtifacts(rrAll)
  const n_rr     = filtered.length
  const data_quality_pct = n_orig > 0 ? Math.round((n_rr / n_orig) * 1000) / 10 : 0

  if (n_rr === 0) {
    return {
      n_rr: 0,
      hr_resting_mean: null, hr_min: null, hr_max: null,
      lnrmssd_app_estimate: null, rmssd_ms: null,
      sdnn_ms: null, pnn50_pct: null, mean_rr_ms: null,
      data_quality_pct,
    }
  }

  const hrValues      = filtered.map(rr => 60000 / rr)
  const hr_resting_mean = Math.round((hrValues.reduce((a, b) => a + b, 0) / hrValues.length) * 10) / 10
  // HR min/max derive from RR max/min (inverse relationship)
  const hr_min = Math.round(60000 / Math.max(...filtered))
  const hr_max = Math.round(60000 / Math.min(...filtered))
  const mean_rr_ms = Math.round(filtered.reduce((a, b) => a + b, 0) / n_rr)

  const { rmssd, lnrmssd } = computeRmssd(filtered)
  const sdnn_ms   = computeSDNN(filtered)
  const pnn50_pct = computePnn50(filtered)

  return {
    n_rr,
    hr_resting_mean,
    hr_min,
    hr_max,
    lnrmssd_app_estimate: lnrmssd,
    rmssd_ms: rmssd,
    sdnn_ms,
    pnn50_pct,
    mean_rr_ms,
    data_quality_pct,
  }
}

/** Convenience: live lnRMSSD only (kept for any legacy callers). */
export function liveLnRmssd(rrAll) {
  return liveMetrics(rrAll).lnrmssd
}
