const RR_MIN_MS = 300
const RR_MAX_MS = 1500
const ECTOPIC_THRESHOLD = 0.20
// Window for live lnRMSSD display (last N beats)
const LIVE_WINDOW = 60

/**
 * Remove out-of-range and ectopic beats.
 * Returns filtered array.
 */
export function filterArtifacts(rr) {
  let arr = rr.filter(v => v >= RR_MIN_MS && v <= RR_MAX_MS)
  if (arr.length < 2) return arr
  const keep = [true]
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i - 1]
    keep.push(Math.abs(arr[i] - prev) / prev <= ECTOPIC_THRESHOLD)
  }
  return arr.filter((_, i) => keep[i])
}

/**
 * Compute RMSSD and lnRMSSD from an RR array (already artifact-filtered).
 * Returns null if fewer than 2 beats.
 */
export function computeRmssd(rr) {
  if (rr.length < 2) return { rmssd: null, lnrmssd: null }
  let sumSq = 0
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1]
    sumSq += d * d
  }
  const rmssd = Math.sqrt(sumSq / (rr.length - 1))
  const lnrmssd = rmssd > 0 ? Math.log(rmssd) : null
  return { rmssd: Math.round(rmssd * 10) / 10, lnrmssd: lnrmssd !== null ? Math.round(lnrmssd * 1000) / 1000 : null }
}

/**
 * Live lnRMSSD from the last LIVE_WINDOW beats (after artifact filter).
 */
export function liveLnRmssd(rrAll) {
  const window = rrAll.slice(-LIVE_WINDOW)
  const filtered = filterArtifacts(window)
  const { lnrmssd } = computeRmssd(filtered)
  return lnrmssd
}

/**
 * Full session metrics from all accumulated RR intervals.
 */
export function computeSessionMetrics(rrAll) {
  const n_orig = rrAll.length
  const filtered = filterArtifacts(rrAll)
  const n_rr = filtered.length
  const data_quality_pct = n_orig > 0 ? Math.round((n_rr / n_orig) * 1000) / 10 : 0

  if (n_rr === 0) return { n_rr: 0, hr_resting_mean: null, lnrmssd_app_estimate: null, rmssd_ms: null, data_quality_pct }

  const hrValues = filtered.map(rr => 60000 / rr)
  const hr_resting_mean = Math.round((hrValues.reduce((a, b) => a + b, 0) / hrValues.length) * 10) / 10

  const { rmssd, lnrmssd } = computeRmssd(filtered)

  return {
    n_rr,
    hr_resting_mean,
    lnrmssd_app_estimate: lnrmssd,
    rmssd_ms: rmssd,
    data_quality_pct,
  }
}
