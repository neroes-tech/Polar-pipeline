import { createClient } from '@supabase/supabase-js'
import { Preferences } from '@capacitor/preferences'
import { withTimeout } from './withTimeout.js'

// ── In-memory cache for auth session ─────────────────────────────────────────
// Every call to supabase.auth.getSession() → __loadSession() → storage.getItem().
// With raw @capacitor/preferences that's an async native round-trip on each DB
// request, which can race on Android. This cache makes getItem() resolve
// synchronously (from memory) while writes still persist to SharedPreferences.
const _cache = {}

// The Capacitor native bridge can stall — observed on the field phone
// alongside a bridge-level "Cannot read properties of undefined (reading
// 'triggerEvent')" error at startup. A stalled bridge call never rejects,
// and supabase-js AWAITS storage.setItem() while saving a session, so a
// hung Preferences.set() left signInWithPassword() pending forever: the
// user was already authenticated server-side, but the app sat on
// "A entrar..." indefinitely. No network timeout could help — the hang is
// after the HTTP call, on the native side.
//
// So: never let the auth flow await the bridge. The in-memory cache is
// updated synchronously (that's what getItem reads, so the session is
// immediately usable), and the native write is fire-and-forget with a
// timeout. Worst case a write is lost and the participant signs in again
// next launch — infinitely better than a frozen app mid-activity.
const BRIDGE_TIMEOUT_MS = 5000

function bridgeCall(label, promiseFactory) {
  return Promise.race([
    Promise.resolve().then(promiseFactory),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`bridge_timeout:${label}`)), BRIDGE_TIMEOUT_MS)
    ),
  ])
}

const CapPrefsStorage = {
  getItem: (key) => Promise.resolve(_cache[key] ?? null),
  setItem(key, value) {
    _cache[key] = value
    bridgeCall('set', () => Preferences.set({ key, value }))
      .catch(e => console.warn('[supabase] persist failed for', key, '—', e?.message))
    return Promise.resolve()
  },
  removeItem(key) {
    delete _cache[key]
    bridgeCall('remove', () => Preferences.remove({ key }))
      .catch(e => console.warn('[supabase] remove failed for', key, '—', e?.message))
    return Promise.resolve()
  },
}

// ── Global fetch timeout for EVERY supabase HTTP call ───────────────────────
// fetch has no timeout of its own: a connection that stalls (rather than
// fails) leaves the promise pending forever. That's bad for any call, but
// fatal for auth ones — supabase-js serializes auth operations through an
// internal lock, so ONE hung sign-in/refresh request blocks every later auth
// call (they queue on the lock and never even reach the network). Observed
// live on the field phone: "A entrar..." spinning for minutes, UI alive
// (language toggle worked), our 15s UI-level timeout unable to help because
// the next attempt just queued behind the same stuck lock. Aborting at the
// fetch layer releases the lock, so retries genuinely retry.
const FETCH_TIMEOUT_MS = 15000

function fetchWithTimeout(input, init = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('fetch timeout', 'AbortError')), FETCH_TIMEOUT_MS)
  // Preserve a caller-provided signal (manual chaining — AbortSignal.any
  // needs Chrome 116+, too new to rely on across participant phones).
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort(init.signal.reason)
    else init.signal.addEventListener('abort', () => ctrl.abort(init.signal.reason), { once: true })
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

// ── Client ────────────────────────────────────────────────────────────────────
// skipAutoInitialize: true — we call auth.initialize() ourselves AFTER the cache
// is populated from Preferences, so the first __loadSession() already has the token.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    global: { fetch: fetchWithTimeout },
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
// Every bridge call here is time-bounded: a stalled Preferences.keys()/get()
// used to mean auth.initialize() was never reached at all, leaving the app
// stuck on its loading screen with no way forward. Failing the preload just
// means no cached session is found — the participant signs in again, which
// is a working app rather than a frozen one.
;(async () => {
  try {
    const { keys } = await bridgeCall('keys', () => Preferences.keys())
    const authKeys = keys.filter(k => k.startsWith('sb-'))
    await Promise.all(authKeys.map(async key => {
      try {
        const { value } = await bridgeCall('get', () => Preferences.get({ key }))
        if (value) _cache[key] = value
      } catch (e) {
        console.warn('[supabase] preload skipped', key, '—', e?.message)
      }
    }))
    console.log('[supabase] cache ready —', Object.keys(_cache).length, 'auth key(s) loaded')
  } catch (e) {
    console.warn('[supabase] Preferences pre-load failed:', e?.message ?? String(e))
  }
  try {
    await supabase.auth.initialize()
    console.log('[supabase] auth initialized')
  } catch (e) {
    console.warn('[supabase] auth initialize failed:', e?.message ?? String(e))
  }
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

// A first-ever login on a device has no cached session to fall back on —
// it genuinely needs a live network round-trip. Without this timeout, weak
// or absent connectivity (a real risk mid-activity, in the field) left the
// login screen stuck on its loading spinner forever: signInWithPassword()
// has no timeout of its own, so a stalled connection never rejects and the
// button's try/catch never runs.
const SIGN_IN_TIMEOUT_MS = 15000

export async function signIn(email, password) {
  const { data, error } = await withTimeout(
    supabase.auth.signInWithPassword({ email, password }),
    SIGN_IN_TIMEOUT_MS,
    'sign_in'
  )
  if (error) throw error
  return data
}

const SHARED_LOGIN_PASSWORD = import.meta.env.VITE_SHARED_LOGIN_PASSWORD

/**
 * Resolves a simplified login field (just "00".."60", or "formador") into
 * a real email + password pair, matching how scripts/create_auth_users.py
 * actually provisioned these accounts:
 *   - "00".."60" → polar00@healme.pt.."polar60@healme.pt", using the shared
 *     password every one of those accounts was created with. Returns
 *     needsPassword: false — the caller must NOT show a password field.
 *     The range is wider than the bands actually in use (34 as of this
 *     write) on purpose — Supabase will simply reject sign-in for any
 *     number that doesn't have a real account yet.
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

  // Upper bound kept generously above the current highest band (34, as of
  // this write) so adding future bands numbered up to 60 needs only a
  // Supabase-side account (scripts/create_auth_users.py) — no app rebuild.
  const digits = username.replace(/\D/g, '')
  const n = Number(digits)
  if (digits && n >= 0 && n <= 60) {
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
 *
 * The query is time-bounded for the same reason: App.jsx awaits this while
 * showing its loading screen, so a request that stalls rather than fails
 * froze the app there indefinitely — with a valid cached participant sitting
 * right there, unused. On timeout we fall through to that cache.
 */
const PARTICIPANT_FETCH_TIMEOUT_MS = 10000

export async function getCurrentParticipant() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return null

    const { data, error } = await withTimeout(
      supabase
        .from('participants')
        .select('id, code, name, device_id')
        .eq('auth_user_id', user.id)
        .single(),
      PARTICIPANT_FETCH_TIMEOUT_MS,
      'participant_fetch'
    )
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
