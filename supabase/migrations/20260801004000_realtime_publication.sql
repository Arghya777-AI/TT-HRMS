-- =============================================================================
-- 040 — REALTIME PUBLICATION (docs/plan/04-data-model.md §11)
-- =============================================================================
-- Opt-in per table: ALTER PUBLICATION supabase_realtime ADD TABLE for exactly
-- the 12 tables in §11. Client subscriptions filter the event kinds
-- (INSERT/UPDATE/DELETE) listed in the doc; the publication itself publishes
-- all events, filtered per subscriber by RLS.
--
--   attendance_punches       INSERT                    kiosk strip / live board
--   attendance_days          INSERT, UPDATE            own attendance card
--   approval_requests        INSERT, UPDATE            inbox badge counts
--   notifications            INSERT                    the bell
--   leave_requests           UPDATE                    applicant status
--   roster_slots             INSERT, UPDATE, DELETE    roster board collaboration
--   kiosk_devices            UPDATE                    kiosk-health tiles
--   payroll_runs             UPDATE                    compute progress
--   attendance_recompute_runs UPDATE                   backfill progress bar
--   announcements            INSERT, UPDATE            noticeboard / safety alerts
--   system_health            INSERT                    admin alert banner
--   ai_messages              INSERT                    multi-tab sync only (SSE streams)
--
-- Deliberately NOT published: employees, payslips, documents, every *_ledger,
-- audit_log, all secure.* (RLS-mistake surface + WAL flood).
--
-- PORTABILITY: guarded on the existence of the supabase_realtime publication,
-- so a vanilla-Postgres validation harness skips this file cleanly.
-- Membership is checked via pg_publication_rel (works for partitioned parents
-- such as attendance_punches, which pg_publication_tables expands to leaves).
-- =============================================================================

BEGIN;

DO $do$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'attendance_punches',
    'attendance_days',
    'approval_requests',
    'notifications',
    'leave_requests',
    'roster_slots',
    'kiosk_devices',
    'payroll_runs',
    'attendance_recompute_runs',
    'announcements',
    'system_health',
    'ai_messages'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'publication supabase_realtime unavailable (vanilla Postgres) — skipped';
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class       c ON c.oid = pr.prrelid
      JOIN pg_namespace   n ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime'
        AND n.nspname = 'public'
        AND c.relname = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      RAISE NOTICE 'added public.% to supabase_realtime', v_table;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
