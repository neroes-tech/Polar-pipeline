/**
 * Rejects if `promise` hasn't settled within `ms`.
 *
 * Exists because a *stalled* request is not the same as a failed one: fetch
 * (and therefore supabase-js) never rejects on its own for a connection that
 * hangs instead of erroring, and neither does the SQLite plugin bridge. Every
 * such await is a potential permanent freeze — which is exactly what happened
 * twice in the field: the sign-in button and then the whole loading screen
 * spinning forever, with no error to show the participant.
 *
 * Rule of thumb for this app: anything awaited on a path that gates the UI
 * (sign-in, launch) must be wrapped. `label` is only for diagnostics.
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms)
  })
  // clearTimeout in finally so a resolved promise doesn't leave a pending
  // timer holding the event loop / firing a stray rejection later.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
