import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export async function getParticipants() {
  const { data, error } = await supabase
    .from('participants')
    .select('id, code, name, device_id')
    .order('code')
  if (error) throw error
  return data
}

/**
 * Upload a completed session.
 * rrIntervals: number[] — raw RR in ms, ordered chronologically
 * metrics: { n_rr, hr_resting_mean, lnrmssd_app_estimate, rmssd_ms, data_quality_pct }
 *
 * UUID is generated client-side so we never call .select() on sessions or
 * rr_intervals — the anon role has INSERT-only access on those tables and
 * Supabase enforces RLS on RETURNING clauses the same as SELECT.
 */
export async function uploadSession(participantId, sessionDate, sessionTime, durationS, rrIntervals, metrics, notes = null) {
  // Generate UUID client-side — avoids .select() / RETURNING on sessions
  const sessionId = crypto.randomUUID()

  // 1. Insert session row (no .select() — anon has INSERT only)
  const { error: sessionErr } = await supabase
    .from('sessions')
    .insert({
      id: sessionId,
      participant_id: participantId,
      session_date: sessionDate,
      session_time: sessionTime,
      duration_s: durationS,
      n_rr: metrics.n_rr,
      data_quality_pct: metrics.data_quality_pct,
      hr_resting_mean: metrics.hr_resting_mean,
      lnrmssd_app_estimate: metrics.lnrmssd_app_estimate,
      rmssd_ms: metrics.rmssd_ms,
      notes,
    })

  if (sessionErr) {
    console.error('[uploadSession] sessions INSERT failed:', sessionErr)
    throw new Error(sessionErr.message)
  }

  // 2. Insert RR intervals in batches of 500 (no .select())
  const BATCH = 500
  for (let i = 0; i < rrIntervals.length; i += BATCH) {
    const rows = rrIntervals.slice(i, i + BATCH).map((rr, j) => ({
      session_id: sessionId,
      seq: i + j,
      rr_ms: rr,
    }))
    const { error: rrErr } = await supabase.from('rr_intervals').insert(rows)
    if (rrErr) {
      console.error(`[uploadSession] rr_intervals INSERT failed (batch ${i / BATCH + 1}):`, rrErr)
      throw new Error(rrErr.message)
    }
  }

  return sessionId
}
