-- ============================================================================
-- `anon` reads no view at all.
--
-- ── WHAT WAS FOUND, AND WHAT IT WAS NOT ─────────────────────────────────────
-- Thirteen views in `public` carried a SELECT grant to `anon` — the unauthenticated
-- key that ships inside the browser bundle. I had previously flagged seven of them
-- as a possible unauthenticated read of employee roles and punch history.
--
-- THAT WAS WRONG, and the correction matters: reading every one of the thirteen as
-- `anon` returns no data. Ten are refused outright, because each view's own WHERE
-- clause calls `app.current_employee_id()`, `app.is_manager_of()` or
-- `app.visible_employee_ids()`, and `anon` holds EXECUTE on none of them —
-- confirmed directly:
--
--   app.current_employee_id()    anon EXECUTE = false
--   app.is_manager_of(uuid)      anon EXECUTE = false
--   app.is_admin()               anon EXECUTE = false
--   app.visible_employee_ids()   anon EXECUTE = false
--
-- So nothing has been exposed. What is wrong is the SHAPE of the protection.
--
-- ── WHY IT IS STILL WORTH CLOSING ───────────────────────────────────────────
-- 1. The door is held by ONE grant on a helper function, not by the grant on the
--    view. Granting EXECUTE on `app.current_employee_id()` to `anon` — an entirely
--    plausible half-hour of debugging — opens ten views at once, silently, with no
--    error anywhere to notice it by.
--
-- 2. THREE OF THEM HAVE NO GATE AT ALL:
--
--      v_appraisal_cycle_progress
--      v_exit_clearance_progress
--      v_scheduled_reports_due
--
--    Their bodies call no `app.*` function. They return nothing today only because
--    the tables behind them are empty. The first exit recorded would publish who is
--    leaving and how far their clearance has got, to anybody holding the publishable
--    key — which is anybody who has opened the site. That is a latent leak with a
--    date on it, not a hypothetical.
--
-- ── WHY A REVOKE AND NOT `security_invoker` ─────────────────────────────────
-- `security_invoker` would make each view honour the caller's RLS, which is the
-- right long-term shape — but it changes what EVERY caller sees, including the
-- authenticated screens these views already serve correctly. That is a behavioural
-- change to thirteen live screens to fix an exposure of zero rows.
--
-- Revoking `anon` changes nothing for anybody: the app reads all of these with a
-- session, and `anon` already gets nothing from them. It removes the fragile layer
-- and leaves the gate functions as the second one, in that order.
--
-- These grants exist because Supabase ships
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, so
-- every view created in `public` arrives readable by `anon` unless somebody says
-- otherwise. Nobody had.
-- ============================================================================

SELECT set_config('app.reason',
  'anon loses SELECT on all thirteen public views it could reach; ten were held only by a helper-function grant and three had no scoping at all',
  true);

DO $do$
DECLARE v record; n integer := 0;
BEGIN
  FOR v IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind = 'v'
       AND has_table_privilege('anon', c.oid, 'SELECT')
     ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', v.relname);
    RAISE NOTICE 'revoked anon from %', v.relname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'anon lost SELECT on % view(s)', n;
END
$do$;

/*
  And stop the next one arriving open. The default privileges are what granted these
  in the first place; narrowing them means a view added tomorrow is not readable by
  `anon` unless somebody grants it deliberately.

  `authenticated` is untouched — the application reads these views with a session and
  every one of them is scoped either by its own gate function or by RLS underneath.
*/
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM anon;
