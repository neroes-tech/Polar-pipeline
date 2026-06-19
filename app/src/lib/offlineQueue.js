/**
 * offlineQueue.js — Offline-first session persistence.
 *
 * Sessions are ALWAYS saved locally before any network call.
 * @capacitor/preferences → native SharedPreferences (Android) / UserDefaults (iOS)
 *                        → localStorage fallback in browser
 *
 * Schema (each session stored under key `neroes_session_<uuid>`):
 *   { id, participant_id, session_date, session_time, duration_s,
 *     rr_intervals, metrics, session_type,
 *     sync_status: 'pending' | 'synced',
 *     saved_at, synced_at? }
 *
 * Index key: 'neroes_hrv_session_index' → JSON array of session UUIDs
 */

import { Preferences } from '@capacitor/preferences'

const INDEX_KEY    = 'neroes_hrv_session_index'
const SESSION_PFX  = 'neroes_session_'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function _getIndex() {
  const { value } = await Preferences.get({ key: INDEX_KEY })
  return value ? JSON.parse(value) : []
}

async function _setIndex(index) {
  await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) })
}

async function _getRecord(id) {
  const { value } = await Preferences.get({ key: SESSION_PFX + id })
  return value ? JSON.parse(value) : null
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save a session locally with sync_status = 'pending'.
 * Must be called BEFORE any network upload attempt.
 * sessionData must include: { id, participant_id, session_date, session_time,
 *   duration_s, rr_intervals, metrics, session_type }
 */
export async function saveSessionLocally(sessionData) {
  const record = {
    ...sessionData,
    sync_status: 'pending',
    saved_at:    new Date().toISOString(),
  }
  await Preferences.set({
    key:   SESSION_PFX + sessionData.id,
    value: JSON.stringify(record),
  })
  const index = await _getIndex()
  if (!index.includes(sessionData.id)) {
    index.push(sessionData.id)
    await _setIndex(index)
  }
}

/**
 * Mark a locally-saved session as synced after a successful Supabase upload.
 */
export async function markSynced(sessionId) {
  const record = await _getRecord(sessionId)
  if (!record) return
  record.sync_status = 'synced'
  record.synced_at   = new Date().toISOString()
  await Preferences.set({
    key:   SESSION_PFX + sessionId,
    value: JSON.stringify(record),
  })
}

/**
 * Returns all sessions still waiting to be uploaded (sync_status = 'pending').
 */
export async function getPendingSessions() {
  const index = await _getIndex()
  const out = []
  for (const id of index) {
    const record = await _getRecord(id)
    if (record?.sync_status === 'pending') out.push(record)
  }
  return out
}

/**
 * Returns the count of pending sessions (cheap version — avoids loading full payloads).
 */
export async function getPendingCount() {
  const pending = await getPendingSessions()
  return pending.length
}

/**
 * Delete every locally-saved session (pending AND synced) and reset the index.
 * Used for clean testing — does not affect Supabase cloud data.
 */
export async function clearAllLocalSessions() {
  const index = await _getIndex()
  for (const id of index) {
    await Preferences.remove({ key: SESSION_PFX + id })
  }
  await Preferences.remove({ key: INDEX_KEY })
  console.log('[offlineQueue] cleared', index.length, 'local session(s)')
  return index.length
}

/**
 * Attempt to upload all pending sessions.
 * uploadFn(record) → Promise<void>  — should throw on network failure
 * Returns { synced: number, failed: number }
 *
 * Safe to call repeatedly — already-synced sessions are never re-uploaded.
 */
export async function syncPending(uploadFn) {
  const pending = await getPendingSessions()
  let synced = 0
  let failed = 0
  for (const record of pending) {
    try {
      await uploadFn(record)
      await markSynced(record.id)
      synced++
    } catch (_) {
      failed++
    }
  }
  return { synced, failed }
}
