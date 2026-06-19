-- ============================================================
-- FASE A Migration — Neroes HRV / HE26
-- Run in Supabase Studio → SQL Editor (tab separado do schema).
--
-- SEGURO em base de dados existente:
--   • ADD COLUMN IF NOT EXISTS → não faz nada se a coluna já existir
--   • CREATE TABLE IF NOT EXISTS → não faz nada se a tabela já existir
--   • Constraints duplicadas são ignoradas com EXCEPTION handling
--
-- Podes correr mais do que uma vez sem problemas.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. Novas colunas na tabela sessions
-- ─────────────────────────────────────────────────────────────

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS session_type   TEXT,
    ADD COLUMN IF NOT EXISTS sdnn_ms        REAL,
    ADD COLUMN IF NOT EXISTS pnn50_pct      REAL,
    ADD COLUMN IF NOT EXISTS mean_rr_ms     REAL,
    ADD COLUMN IF NOT EXISTS hr_min         INTEGER,
    ADD COLUMN IF NOT EXISTS hr_max         INTEGER,
    ADD COLUMN IF NOT EXISTS has_ecg        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sync_status    TEXT    NOT NULL DEFAULT 'synced';

-- CHECK constraint em session_type (ignora se já existir)
DO $$
BEGIN
    ALTER TABLE sessions
        ADD CONSTRAINT sessions_session_type_check
        CHECK (session_type IN ('rest_5min', 'free') OR session_type IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

-- CHECK constraint em sync_status (ignora se já existir)
DO $$
BEGIN
    ALTER TABLE sessions
        ADD CONSTRAINT sessions_sync_status_check
        CHECK (sync_status IN ('synced', 'pending', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- 2. Nova tabela ecg_samples
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ecg_samples (
    id              BIGSERIAL   PRIMARY KEY,
    session_id      UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER     NOT NULL,
    voltage_uv      INTEGER     NOT NULL,
    timestamp_ms    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_ecg_session     ON ecg_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_ecg_session_seq ON ecg_samples(session_id, seq);


-- ─────────────────────────────────────────────────────────────
-- 3. RLS para ecg_samples
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ecg_samples ENABLE ROW LEVEL SECURITY;

-- Remove políticas existentes na ecg_samples (safe re-run)
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'ecg_samples'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
    END LOOP;
END;
$$;

CREATE POLICY "anon_insert_ecg_samples"
    ON ecg_samples
    FOR INSERT
    TO anon
    WITH CHECK (true);


-- ─────────────────────────────────────────────────────────────
-- 4. Verificação — corre após a migração
-- ─────────────────────────────────────────────────────────────

-- Confirma colunas novas na sessions:
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'sessions'
  AND column_name IN (
      'session_type','sdnn_ms','pnn50_pct','mean_rr_ms',
      'hr_min','hr_max','has_ecg','sync_status'
  )
ORDER BY ordinal_position;

-- Confirma ecg_samples e RLS:
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename IN ('sessions', 'ecg_samples');

-- Confirma política anon INSERT em ecg_samples:
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename  = 'ecg_samples';
