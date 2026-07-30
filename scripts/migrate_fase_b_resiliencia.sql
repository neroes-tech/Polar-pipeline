-- ============================================================
-- FASE B Migration — Neroes HRV / HE26
-- Resiliência offline: gravação incremental local (SQLite) + reconciliação
-- de sessões órfãs após crash/kill. Ver app/src/lib/localSessionStore.js.
--
-- Run em Supabase Studio → SQL Editor (tab separado do schema).
--
-- SEGURO em base de dados existente:
--   • ADD COLUMN IF NOT EXISTS → não faz nada se a coluna já existir
--
-- Podes correr mais do que uma vez sem problemas.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. Novas colunas na tabela sessions
-- ─────────────────────────────────────────────────────────────

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS recovered BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS gap_s     INTEGER NOT NULL DEFAULT 0;


-- ─────────────────────────────────────────────────────────────
-- 2. Verificação — corre após a migração
-- ─────────────────────────────────────────────────────────────

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'sessions'
  AND column_name IN ('recovered', 'gap_s')
ORDER BY ordinal_position;
