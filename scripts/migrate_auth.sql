-- ═══════════════════════════════════════════════════════════════════════════
-- migrate_auth.sql — Supabase Auth integration for Neroes HRV
--
-- WHAT THIS DOES:
--   1. Adds auth_user_id to participants (links each band account → row)
--   2. Drops ALL previous anon policies (they no longer apply)
--   3. Creates new RLS policies for the `authenticated` role:
--        participants → SELECT own row only
--        sessions     → INSERT for own participant only
--        rr_intervals → INSERT if session belongs to own participant
--        ecg_samples  → INSERT if session belongs to own participant
--
-- RUN IN: Supabase Dashboard → SQL Editor (run once, after create_auth_users.py)
--
-- PIPELINE: service_role key bypasses RLS entirely — unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Add auth_user_id to participants ──────────────────────────────────────

ALTER TABLE participants
ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 2. Drop ALL existing policies (previous anon policies) ───────────────────

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

-- ── 3. New RLS policies for `authenticated` role ─────────────────────────────

-- participants: each account can only see its own row
CREATE POLICY "auth_select_own_participant"
ON participants
FOR SELECT
TO authenticated
USING (auth_user_id = auth.uid());

-- sessions: can INSERT only for the participant linked to the logged-in account
CREATE POLICY "auth_insert_own_session"
ON sessions
FOR INSERT
TO authenticated
WITH CHECK (
    participant_id IN (
        SELECT id FROM participants WHERE auth_user_id = auth.uid()
    )
);

-- rr_intervals: can INSERT only if the session belongs to own participant
CREATE POLICY "auth_insert_own_rr"
ON rr_intervals
FOR INSERT
TO authenticated
WITH CHECK (
    session_id IN (
        SELECT s.id
        FROM   sessions s
        JOIN   participants p ON s.participant_id = p.id
        WHERE  p.auth_user_id = auth.uid()
    )
);

-- ecg_samples: same constraint as rr_intervals
CREATE POLICY "auth_insert_own_ecg"
ON ecg_samples
FOR INSERT
TO authenticated
WITH CHECK (
    session_id IN (
        SELECT s.id
        FROM   sessions s
        JOIN   participants p ON s.participant_id = p.id
        WHERE  p.auth_user_id = auth.uid()
    )
);

-- ── 4. Verification queries (run separately to confirm) ───────────────────────
--
-- Check auth_user_id column exists:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'participants' AND column_name = 'auth_user_id';
--
-- Check new policies (expected: 4 rows, all TO authenticated):
-- SELECT tablename, policyname, cmd, roles
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('participants','sessions','rr_intervals','ecg_samples')
--   ORDER BY tablename, policyname;
--
-- Verify auth_user_id populated (run AFTER create_auth_users.py):
-- SELECT code, auth_user_id IS NOT NULL AS has_auth
--   FROM participants
--   ORDER BY code;
