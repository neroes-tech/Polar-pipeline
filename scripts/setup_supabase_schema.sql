-- ============================================================
-- Neroes HRV Pipeline — Supabase Schema
-- Study: HE26
--
-- Run this once in Supabase Studio → SQL Editor.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ── Tables ───────────────────────────────────────────────────

-- Participants: static, configured once before the study.
-- device_id = H10 Bluetooth serial number (e.g. "1B133137").
-- Populated via scripts/seed_participants.py using service_role key.
CREATE TABLE IF NOT EXISTS participants (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT        UNIQUE NOT NULL,   -- "HM01" … "HM22"
    name        TEXT,
    birthdate   DATE,
    gender      TEXT        CHECK (gender IN ('M', 'F', 'OTHER') OR gender IS NULL),
    height_cm   REAL,
    weight_kg   REAL,
    device_id   TEXT,                          -- H10 BT serial, used by app to connect
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Sessions: one row per recording (5-min rest or free mode).
-- lnrmssd_app_estimate and other *_app columns = quick calc in the app
-- for live feedback only.  Definitive metrics are from the Python pipeline.
CREATE TABLE IF NOT EXISTS sessions (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id          UUID        NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
    session_date            DATE        NOT NULL,
    session_time            TIME        NOT NULL,
    duration_s              INTEGER,
    n_rr                    INTEGER,
    data_quality_pct        REAL,
    hr_resting_mean         REAL,
    lnrmssd_app_estimate    REAL,
    rmssd_ms                REAL,
    -- ── FASE A additions ──────────────────────────────────────
    session_type            TEXT        CHECK (session_type IN ('rest_5min', 'free') OR session_type IS NULL),
    sdnn_ms                 REAL,
    pnn50_pct               REAL,
    mean_rr_ms              REAL,
    hr_min                  INTEGER,
    hr_max                  INTEGER,
    has_ecg                 BOOLEAN     NOT NULL DEFAULT FALSE,
    sync_status             TEXT        NOT NULL DEFAULT 'synced'
                                        CHECK (sync_status IN ('synced', 'pending', 'error')),
    -- ─────────────────────────────────────────────────────────
    uploaded_at             TIMESTAMPTZ DEFAULT now(),
    notes                   TEXT
);

-- RR intervals: raw beat-to-beat data, one row per beat.
-- seq = 0-indexed position within the session.
-- rr_ms values expected between 300–1500 ms (40–200 bpm range).
CREATE TABLE IF NOT EXISTS rr_intervals (
    id              BIGSERIAL   PRIMARY KEY,
    session_id      UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER     NOT NULL,
    rr_ms           SMALLINT    NOT NULL,
    timestamp_ms    BIGINT
);

-- ECG samples: raw voltage stream from Polar H10 proprietary BLE SDK.
-- 130 Hz → ~39 000 samples per 5-min session.
-- Only populated when has_ecg = TRUE on the parent session.
-- seq = 0-indexed sample order; voltage_uv in microvolts.
CREATE TABLE IF NOT EXISTS ecg_samples (
    id              BIGSERIAL   PRIMARY KEY,
    session_id      UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER     NOT NULL,
    voltage_uv      INTEGER     NOT NULL,
    timestamp_ms    BIGINT
);


-- ── Indexes ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_rr_session      ON rr_intervals(session_id);
CREATE INDEX IF NOT EXISTS idx_rr_session_seq  ON rr_intervals(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_ecg_session     ON ecg_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_ecg_session_seq ON ecg_samples(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_pid    ON sessions(participant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date   ON sessions(session_date);


-- ── Row Level Security ───────────────────────────────────────
-- service_role key (Python pipeline) bypasses RLS entirely — no policies needed for it.
-- anon key (PWA app) is restricted to:
--   participants → SELECT only (load participant list)
--   sessions     → INSERT only
--   rr_intervals → INSERT only
--   ecg_samples  → INSERT only

ALTER TABLE participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rr_intervals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ecg_samples   ENABLE ROW LEVEL SECURITY;

-- Drop ALL existing policies on these tables regardless of name (safe for re-runs).
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('participants', 'sessions', 'rr_intervals', 'ecg_samples')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
    END LOOP;
END;
$$;

-- participants: anon can SELECT (to load the participant list in the app)
CREATE POLICY "anon_select_participants"
    ON participants
    FOR SELECT
    TO anon
    USING (true);

-- sessions: anon can INSERT only — never SELECT/UPDATE/DELETE (privacy)
CREATE POLICY "anon_insert_sessions"
    ON sessions
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- rr_intervals: write only
CREATE POLICY "anon_insert_rr_intervals"
    ON rr_intervals
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- ecg_samples: write only
CREATE POLICY "anon_insert_ecg_samples"
    ON ecg_samples
    FOR INSERT
    TO anon
    WITH CHECK (true);


-- ── Verification ─────────────────────────────────────────────
-- Run these queries separately after the script to confirm the result.
--
-- Tables with RLS enabled (expected: 4 rows):
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename IN ('participants','sessions','rr_intervals','ecg_samples');
--
-- Policies (expected: 4 rows, cmd = SELECT / INSERT / INSERT / INSERT):
-- SELECT tablename, policyname, cmd, roles
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('participants','sessions','rr_intervals','ecg_samples')
--   ORDER BY tablename;
--
-- sessions columns added by FASE A:
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'sessions'
--   ORDER BY ordinal_position;
