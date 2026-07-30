/**
 * localSessionStore.js — Crash-safe, incremental local session storage.
 *
 * Replaces the old offlineQueue.js + sessionPersistence.js pair. Those wrote
 * the ENTIRE session (all RR intervals + all ECG samples, held in memory for
 * the whole recording) to @capacitor/preferences exactly once, at the very
 * end of a session. If the app process died mid-session — Android OOM/OEM
 * kill, screen-off suspension, WebView reload — everything collected so far
 * was lost with no recovery path. That is the direct cause of missing data
 * during long, no-network moments (a multi-hour "free" session with the
 * phone in a pocket).
 *
 * This module writes every beat/sample to a local SQLite database (native)
 * as it arrives (batched every few seconds by the caller — see Record.jsx),
 * so a session's data survives a crash up to the last flush. On the next
 * app launch, any session still marked `status = 'recording'` is an orphan
 * from a kill and gets reconciled by recoverOrphanedSessions().
 *
 * Table shapes mirror the remote Supabase tables (sessions / rr_intervals /
 * ecg_samples in supabase.js) 1:1, so getPendingSessions() returns records
 * shaped exactly like what uploadSessionRecord()/uploadEcgSamples() expect.
 *
 * Web (browser dev preview, not used for real field recording) has no native
 * SQLite — falls back to a single JSON blob in localStorage, same as the
 * old offlineQueue.js did. That fallback is not crash-safe; it's only meant
 * to keep `npm run dev` usable for UI work.
 */

import { Capacitor } from '@capacitor/core'
import { computeSessionMetrics } from './hrvCalc.js'

const DB_NAME    = 'neroes_hrv'
const WEB_KEY    = 'neroes_web_sessions_v1'
const isNative   = () => Capacitor.isNativePlatform()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  participant_id  TEXT NOT NULL,
  session_date    TEXT,
  session_time    TEXT,
  session_type    TEXT,
  duration_s      INTEGER,
  status          TEXT NOT NULL DEFAULT 'recording',
  has_ecg         INTEGER NOT NULL DEFAULT 0,
  metrics_json    TEXT,
  recovered       INTEGER NOT NULL DEFAULT 0,
  gap_s           INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  updated_at      TEXT,
  saved_at        TEXT,
  synced_at       TEXT
);
CREATE TABLE IF NOT EXISTS rr_intervals (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  rr_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rr_session ON rr_intervals(session_id);
CREATE TABLE IF NOT EXISTS ecg_samples (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  voltage_uv INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ecg_session ON ecg_samples(session_id);
`

// ── Native SQLite backend ────────────────────────────────────────────────────

let _sqlite  = null   // SQLiteConnection instance
let _db      = null   // native DB connection
let _readyP  = null    // init promise (dedup concurrent initLocalStore() calls)

async function _openNative() {
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite')
  _sqlite = new SQLiteConnection(CapacitorSQLite)
  const { result: exists } = await _sqlite.isConnection(DB_NAME, false)
  _db = exists
    ? await _sqlite.retrieveConnection(DB_NAME, false)
    : await _sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  await _db.open()
  await _db.execute(SCHEMA)
}

// ── Web fallback backend (dev preview only — not crash-safe) ────────────────

function _webLoad() {
  try {
    const raw = localStorage.getItem(WEB_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function _webSave(all) {
  try { localStorage.setItem(WEB_KEY, JSON.stringify(all)) } catch (_) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initLocalStore() {
  if (!_readyP) {
    _readyP = isNative() ? _openNative() : Promise.resolve()
  }
  return _readyP
}

async function _ensureReady() {
  await initLocalStore()
}

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Create a `recording` row for a brand-new session, BEFORE any beat/sample
 * has arrived. Call this at the start of a recording, not the end.
 */
export async function beginSession({ id, participant_id, session_date, session_time, session_type }) {
  await _ensureReady()
  const now = new Date().toISOString()
  if (isNative()) {
    await _db.run(
      `INSERT INTO sessions
         (id, participant_id, session_date, session_time, session_type, status, started_at, updated_at, saved_at)
       VALUES (?, ?, ?, ?, ?, 'recording', ?, ?, ?)`,
      [id, participant_id, session_date, session_time, session_type, now, now, now]
    )
  } else {
    const all = _webLoad()
    all[id] = {
      id, participant_id, session_date, session_time, session_type,
      status: 'recording', has_ecg: 0, metrics: null,
      recovered: false, gap_s: 0,
      started_at: now, updated_at: now, saved_at: now, synced_at: null,
      rr_intervals: [], ecg_samples: [],
    }
    _webSave(all)
  }
}

/** Append a batch of RR intervals (ms) for an in-progress session. Cheap — call every few seconds. */
export async function appendRr(sessionId, rrArray, startSeq) {
  if (!rrArray || rrArray.length === 0) return
  await _ensureReady()
  if (isNative()) {
    const set = rrArray.map((rr, i) => ({
      statement: 'INSERT INTO rr_intervals (session_id, seq, rr_ms) VALUES (?, ?, ?)',
      values:    [sessionId, startSeq + i, Math.round(rr)],
    }))
    await _db.executeSet(set)
    await _touch(sessionId)
  } else {
    const all = _webLoad()
    const s = all[sessionId]
    if (!s) return
    rrArray.forEach((rr, i) => s.rr_intervals.push({ seq: startSeq + i, rr_ms: Math.round(rr) }))
    s.updated_at = new Date().toISOString()
    _webSave(all)
  }
}

/** Append a batch of ECG samples (µV) for an in-progress session. Cheap — call every few seconds. */
export async function appendEcg(sessionId, samples, startSeq) {
  if (!samples || samples.length === 0) return
  await _ensureReady()
  if (isNative()) {
    const set = samples.map((v, i) => ({
      statement: 'INSERT INTO ecg_samples (session_id, seq, voltage_uv) VALUES (?, ?, ?)',
      values:    [sessionId, startSeq + i, Math.round(v)],
    }))
    await _db.executeSet(set)
    await _touch(sessionId)
  } else {
    const all = _webLoad()
    const s = all[sessionId]
    if (!s) return
    samples.forEach((v, i) => s.ecg_samples.push({ seq: startSeq + i, voltage_uv: Math.round(v) }))
    s.updated_at = new Date().toISOString()
    _webSave(all)
  }
}

async function _touch(sessionId) {
  await _db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), sessionId])
}

/**
 * Mark a session as finished cleanly (user stopped it, or it auto-stopped).
 * RR/ECG data is already in SQLite from appendRr/appendEcg — this only
 * writes the final metadata (duration, metrics, has_ecg) and flips status
 * to 'pending' so it gets picked up by syncPending().
 */
export async function finishSession(sessionId, { duration_s, metrics, has_ecg, gap_s = 0 }) {
  await _ensureReady()
  const now = new Date().toISOString()
  if (isNative()) {
    await _db.run(
      `UPDATE sessions
         SET status = 'pending', duration_s = ?, has_ecg = ?, metrics_json = ?, gap_s = ?, saved_at = ?, updated_at = ?
       WHERE id = ?`,
      [duration_s, has_ecg ? 1 : 0, JSON.stringify(metrics), gap_s, now, now, sessionId]
    )
  } else {
    const all = _webLoad()
    const s = all[sessionId]
    if (!s) return
    Object.assign(s, { status: 'pending', duration_s, has_ecg: has_ecg ? 1 : 0, metrics, gap_s, saved_at: now, updated_at: now })
    _webSave(all)
  }
}

/** User explicitly cancelled a recording — discard it entirely (not an orphan, not pending). */
export async function discardSession(sessionId) {
  await _ensureReady()
  if (isNative()) {
    await _db.run('DELETE FROM rr_intervals WHERE session_id = ?', [sessionId])
    await _db.run('DELETE FROM ecg_samples WHERE session_id = ?',  [sessionId])
    await _db.run('DELETE FROM sessions WHERE id = ?',             [sessionId])
  } else {
    const all = _webLoad()
    delete all[sessionId]
    _webSave(all)
  }
}

/** Mark a pending session as uploaded — never re-synced after this. */
export async function markSynced(sessionId) {
  await _ensureReady()
  const now = new Date().toISOString()
  if (isNative()) {
    await _db.run('UPDATE sessions SET status = ?, synced_at = ? WHERE id = ?', ['synced', now, sessionId])
  } else {
    const all = _webLoad()
    const s = all[sessionId]
    if (!s) return
    s.status = 'synced'
    s.synced_at = now
    _webSave(all)
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function _getOrderedColumn(sessionId, table, column) {
  if (isNative()) {
    const { values } = await _db.query(
      `SELECT ${column} FROM ${table} WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId]
    )
    return (values || []).map(r => r[column])
  }
  const all = _webLoad()
  const s = all[sessionId]
  if (!s) return []
  const rows = table === 'rr_intervals' ? s.rr_intervals : s.ecg_samples
  return [...rows].sort((a, b) => a.seq - b.seq).map(r => r[column])
}

const _getRrArray  = (id) => _getOrderedColumn(id, 'rr_intervals', 'rr_ms')
const _getEcgArray = (id) => _getOrderedColumn(id, 'ecg_samples',  'voltage_uv')

/**
 * Full RR/ECG arrays for a session, in order. Used both by getPendingSessions()
 * and by Record.jsx to resume a session that survived an Activity kill — the
 * authoritative source for "what's already been captured" is always SQLite,
 * never the in-memory recorder (which resets to empty on every JS reload).
 */
export async function getSessionArrays(sessionId) {
  await _ensureReady()
  return { rr: await _getRrArray(sessionId), ecg: await _getEcgArray(sessionId) }
}

/** Every session still sitting in 'recording' state — orphans from a previous kill. */
export async function getOrphanedSessions() {
  await _ensureReady()
  if (isNative()) {
    const { values } = await _db.query(`SELECT * FROM sessions WHERE status = 'recording'`)
    return values || []
  }
  return Object.values(_webLoad()).filter(s => s.status === 'recording')
}

/**
 * Reconcile every orphaned ('recording') session left over from a crash/kill:
 *   - sessions with zero recorded beats/samples are discarded silently (nothing
 *     was ever captured, e.g. the app died before BLE even connected)
 *   - sessions with partial data get metrics computed from what made it to
 *     disk, are flagged recovered = true, and flip to 'pending' so the normal
 *     sync path picks them up.
 * excludeSessionId: skip this one — App.jsx uses this to keep an orphan that
 * belongs to the current participant OUT of finalization, because it's about
 * to be resumed live in Record.jsx instead of being closed out as "done".
 * Returns the number of sessions recovered with partial data.
 */
export async function recoverOrphanedSessions(excludeSessionId = null) {
  await _ensureReady()
  const orphans = (await getOrphanedSessions()).filter(o => o.id !== excludeSessionId)
  let recovered = 0
  for (const o of orphans) {
    const rr  = await _getRrArray(o.id)
    const ecg = await _getEcgArray(o.id)
    if (rr.length === 0 && ecg.length === 0) {
      await discardSession(o.id)
      continue
    }
    const metrics    = computeSessionMetrics(rr)
    const startedAt  = new Date(o.started_at || o.saved_at).getTime()
    const updatedAt  = new Date(o.updated_at || o.saved_at).getTime()
    const duration_s = Math.max(0, Math.round((updatedAt - startedAt) / 1000))
    const now = new Date().toISOString()
    if (isNative()) {
      await _db.run(
        `UPDATE sessions
           SET status = 'pending', duration_s = ?, has_ecg = ?, metrics_json = ?, recovered = 1, saved_at = ?
         WHERE id = ?`,
        [duration_s, ecg.length > 0 ? 1 : 0, JSON.stringify(metrics), now, o.id]
      )
    } else {
      const all = _webLoad()
      const s = all[o.id]
      if (s) {
        Object.assign(s, { status: 'pending', duration_s, has_ecg: ecg.length > 0 ? 1 : 0, metrics, recovered: true, saved_at: now })
        _webSave(all)
      }
    }
    recovered++
  }
  return recovered
}

/** Full records ready for upload — shape matches uploadSessionRecord()/uploadEcgSamples() params. */
export async function getPendingSessions() {
  await _ensureReady()
  let rows
  if (isNative()) {
    const { values } = await _db.query(`SELECT * FROM sessions WHERE status = 'pending' ORDER BY saved_at ASC`)
    rows = values || []
  } else {
    rows = Object.values(_webLoad()).filter(s => s.status === 'pending')
  }
  const out = []
  for (const r of rows) {
    out.push({
      id:             r.id,
      participant_id: r.participant_id,
      session_date:   r.session_date,
      session_time:   r.session_time,
      duration_s:     r.duration_s,
      session_type:   r.session_type,
      has_ecg:        !!r.has_ecg,
      recovered:      !!r.recovered,
      gap_s:          r.gap_s || 0,
      metrics:        isNative() ? JSON.parse(r.metrics_json || '{}') : (r.metrics || {}),
      rr_intervals:   await _getRrArray(r.id),
      ecg_samples:    await _getEcgArray(r.id),
    })
  }
  return out
}

export async function getPendingCount() {
  await _ensureReady()
  if (isNative()) {
    const { values } = await _db.query(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'pending'`)
    return values?.[0]?.n ?? 0
  }
  return Object.values(_webLoad()).filter(s => s.status === 'pending').length
}

/**
 * Attempt to upload every pending session.
 * uploadFn(record) → Promise<void> — should throw on network failure.
 * Safe to call repeatedly — synced sessions are never re-uploaded.
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

/** Delete every locally-saved session (recording/pending/synced). Debug/testing only. */
export async function clearAllLocalSessions() {
  await _ensureReady()
  if (isNative()) {
    const { values } = await _db.query('SELECT id FROM sessions')
    const n = (values || []).length
    await _db.execute('DELETE FROM rr_intervals; DELETE FROM ecg_samples; DELETE FROM sessions;')
    console.log('[localSessionStore] cleared', n, 'local session(s)')
    return n
  }
  const all = _webLoad()
  const n = Object.keys(all).length
  _webSave({})
  console.log('[localSessionStore] cleared', n, 'local session(s)')
  return n
}
