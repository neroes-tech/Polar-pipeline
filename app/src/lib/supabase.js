import { createClient } from '@supabase/supabase-js'
import { Preferences } from '@capacitor/preferences'

// ── In-memory cache for auth session ─────────────────────────────────────────
// Every call to supabase.auth.getSession() → __loadSession() → storage.getItem().
// With raw @capacitor/preferences that's an async native round-trip on each DB
// request, which can race on Android. This cache makes getItem() resolve
// synchronously (from memory) while writes still persist to SharedPreferences.
const _cache = {}

const CapPrefsStorage = {
  getItem:    (key)        => Promise.resolve(_cache[key] ?? null),
  async setItem(key, value) { _cache[key] = value; await Preferences.set({ key, value }) },
  async removeItem(key)     { delete _cache[key];  await Preferences.remove({ key }) },
}

// ── Client ────────────────────────────────────────────────────────────────────
// skipAutoInitialize: true — we call auth.initialize() ourselves AFTER the cache
// is populated from Preferences, so the first __loadSession() already has the token.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storage:            CapPrefsStorage,
      persistSession:     true,
      autoRefreshToken:   true,
      detectSessionInUrl: false,
      skipAutoInitialize: true,
    },
  }
)

// Pre-populate the in-memory cache from Preferences, then initialize auth.
// App.jsx subscribes to onAuthStateChange before this resolves (React useEffect
// runs before native Preferences.keys() returns), so INITIAL_SESSION always fires
// into an active subscriber.
;(async () => {
  try {
    const { keys } = await Preferences.keys()
    const authKeys = keys.filter(k => k.startsWith('sb-'))
    await Promise.all(authKeys.map(async key => {
      const { value } = await Preferences.get({ key })
      if (value) _cache[key] = value
    }))
    console.log('[supabase] cache ready —', Object.keys(_cache).length, 'auth key(s) loaded')
  } catch (e) {
    console.warn('[supabase] Preferences pre-load failed:', e?.message ?? String(e))
  }
  await supabase.auth.initialize()
  console.log('[supabase] auth initialized')
})()

// ── Helpers ───────────────────────────────────────────────────────────────────

function logSupabaseError(context, err) {
  console.error(
    `[upload] ${context} —`,
    'code:', err?.code ?? 'n/a',
    '| msg:', err?.message ?? 'n/a',
    '| hint:', err?.hint ?? '',
    '| details:', err?.details ?? '',
    '| full:', JSON.stringify(err)
  )
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

const SHARED_LOGIN_PASSWORD = import.meta.env.VITE_SHARED_LOGIN_PASSWORD

/**
 * Resolves a simplified login field (just "00".."31", or "formador") into
 * a real email + password pair, matching how scripts/create_auth_users.py
 * actually provisioned these accounts:
 *   - "00".."31" → polar00@healme.pt.."polar31@healme.pt", using the shared
 *     password every one of those accounts was created with. Returns
 *     needsPassword: false — the caller must NOT show a password field.
 *   - "formador" → formador@healme.pt, its OWN real password — that account
 *     was set up separately and deliberately keeps a real password, so
 *     needsPassword: true.
 * Returns null for anything else (invalid input).
 */
export function resolveLoginIdentity(usernameRaw) {
  const username = (usernameRaw || '').trim().toLowerCase()
  if (!username) return null

  if (username === 'formador') {
    return { email: 'formador@healme.pt', needsPassword: true }
  }

  const digits = username.replace(/\D/g, '')
  const n = Number(digits)
  if (digits && n >= 0 && n <= 31) {
    return {
      email:         `polar${String(n).padStart(2, '0')}@healme.pt`,
      needsPassword: false,
      password:      SHARED_LOGIN_PASSWORD,
    }
  }

  return null
}

export async function signOut() {
  await supabase.auth.signOut()
}

const PARTICIPANT_CACHE_KEY = 'neroes_participant_cache'

/**
 * Returns the participant row for the currently logged-in user.
 * RLS ensures only the authenticated user's own row is returned.
 * Returns null if not logged in (no session anywhere, cached or otherwise).
 *
 * Deliberately offline-tolerant: reopening the app with no network (the
 * desert/pyramid case) must never force a fresh login just because Supabase
 * is unreachable right now. getSession() reads the persisted session from
 * local storage — no network call — unlike getUser(), which ALWAYS hits the
 * network to revalidate. Fixed a real bug where getUser() failing offline
 * bubbled up through App.jsx's loadParticipant() and forced the login
 * screen, skipping the whole resume-session flow (which never even got a
 * chance to run) even though the session was perfectly valid on disk.
 */
export async function getCurrentParticipant() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return null

    const { data, error } = await supabase
      .from('participants')
      .select('id, code, name, device_id')
      .eq('auth_user_id', user.id)
      .single()
    if (error || !data) throw error || new Error('participant not found')

    // Cache for the next launch, in case that one happens offline.
    await Preferences.set({
      key:   PARTICIPANT_CACHE_KEY,
      value: JSON.stringify({ userId: user.id, participant: data }),
    })
    return data
  } catch (e) {
    console.warn('[getCurrentParticipant] live fetch failed, trying cache:', e?.message)
    return await getCachedParticipant()
  }
}

async function getCachedParticipant() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) return null
    const { value } = await Preferences.get({ key: PARTICIPANT_CACHE_KEY })
    if (!value) return null
    const cached = JSON.parse(value)
    // Only trust the cache if it belongs to the currently-signed-in user —
    // matters if the device ever gets re-provisioned for a different participant.
    return cached.userId === userId ? cached.participant : null
  } catch (_) {
    return null
  }
}

export async function getParticipants() {
  const { data, error } = await supabase
    .from('participants')
    .select('id, code, name, device_id')
    .order('code')
  if (error) throw error
  return data
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload a session record.
 * Accepts the full record object (including pre-assigned id) so there are
 * no duplicate UUID issues when retrying a pending session.
 *
 * Error code 23505 (duplicate key) is treated as success.
 */
export async function uploadSessionRecord({ id, participant_id, session_date, session_time, duration_s, rr_intervals, metrics, session_type, has_ecg = false, recovered = false, gap_s = 0, notes = null }) {
  // Log auth state — confirms token is active when upload fires
  const { data: { session: authSession } } = await supabase.auth.getSession()
  console.log(
    '[upload] auth session present:', !!authSession,
    '| user:', authSession?.user?.email ?? 'NONE',
    '| exp:', authSession?.expires_at ?? 'n/a',
    '| cache keys:', Object.keys(_cache).length,
    '| token prefix:', authSession?.access_token?.slice(0, 20) ?? 'NONE'
  )

  // ── 1. Insert session row ─────────────────────────────────────────────────
  const { error: sessionErr } = await supabase
    .from('sessions')
    .insert({
      id,
      participant_id,
      session_date,
      session_time,
      duration_s,
      n_rr:                 metrics.n_rr,
      data_quality_pct:     metrics.data_quality_pct,
      hr_resting_mean:      metrics.hr_resting_mean,
      hr_min:               metrics.hr_min,
      hr_max:               metrics.hr_max,
      lnrmssd_app_estimate: metrics.lnrmssd_app_estimate,
      rmssd_ms:             metrics.rmssd_ms,
      sdnn_ms:              metrics.sdnn_ms,
      pnn50_pct:            metrics.pnn50_pct,
      mean_rr_ms:           metrics.mean_rr_ms,
      session_type,
      has_ecg,
      recovered,
      gap_s,
      notes,
    })

  if (sessionErr) {
    if (sessionErr.code === '23505') {
      console.log('[upload] sessions — duplicate key, already uploaded, continuing')
    } else {
      logSupabaseError('sessions INSERT', sessionErr)
      throw new Error(sessionErr.message)
    }
  } else {
    console.log('[upload] sessions INSERT ok, id:', id?.slice(0, 8))
  }

  // ── 2. Insert RR intervals in batches of 500 ─────────────────────────────
  const RR_BATCH = 500
  for (let i = 0; i < rr_intervals.length; i += RR_BATCH) {
    const rows = rr_intervals.slice(i, i + RR_BATCH).map((rr, j) => ({
      session_id: id,
      seq:        i + j,
      rr_ms:      Math.round(rr),
    }))
    const { error: rrErr } = await supabase.from('rr_intervals').insert(rows)
    if (rrErr) {
      if (rrErr.code === '23505') {
        console.log('[upload] rr_intervals batch', Math.floor(i / RR_BATCH) + 1, '— duplicate, skipping')
        continue
      }
      logSupabaseError(`rr_intervals batch ${Math.floor(i / RR_BATCH) + 1}`, rrErr)
      throw new Error(rrErr.message)
    }
    console.log('[upload] rr_intervals batch', Math.floor(i / RR_BATCH) + 1, '— ok,', rows.length, 'rows')
  }

  return id
}

/**
 * Upload ECG samples for a session in batches of 1000 rows.
 * µVArray: plain number array of signed integer µV values ordered by time.
 * Duplicate key (23505) is silently skipped — safe to retry failed batches.
 */
export async function uploadEcgSamples(sessionId, µVArray) {
  if (!µVArray || µVArray.length === 0) return
  const BATCH = 1000
  for (let i = 0; i < µVArray.length; i += BATCH) {
    const rows = []
    const end  = Math.min(i + BATCH, µVArray.length)
    for (let j = i; j < end; j++) {
      rows.push({ session_id: sessionId, seq: j, voltage_uv: Math.round(µVArray[j]) })
    }
    const { error } = await supabase.from('ecg_samples').insert(rows)
    if (error) {
      if (error.code === '23505') continue
      logSupabaseError(`ecg_samples batch ${Math.floor(i / BATCH) + 1}`, error)
      throw new Error(error.message)
    }
  }
}

// ── Debug utility (clean test) ────────────────────────────────────────────────
// Clears all Supabase auth tokens from Preferences and the in-memory cache.
// Forces a fresh login on next app launch.
// Usage from Logcat/DevTools console: window.__clearAuth()
export async function clearLocalAuth() {
  const keysToRemove = Object.keys(_cache).filter(k => k.startsWith('sb-'))
  for (const key of keysToRemove) {
    delete _cache[key]
    await Preferences.remove({ key })
  }
  // Also do a full Supabase signOut (clears its internal state)
  await supabase.auth.signOut({ scope: 'local' })
  console.log('[supabase] local auth cleared —', keysToRemove.length, 'key(s) removed')
}

if (typeof window !== 'undefined') {
  window.__clearAuth = clearLocalAuth
}
