-- =============================================================================
-- 039 — STORAGE BUCKETS + storage.objects POLICIES (docs/plan/04-data-model.md §10)
-- =============================================================================
-- All buckets private except `brand`. Reads for sensitive buckets happen via
-- short-lived signed URLs minted by edge functions (service role); the
-- policies below cover only what authenticated users may touch DIRECTLY.
--
-- PORTABILITY: every statement is inside a DO block guarded on the existence
-- of the `storage` schema, and executed dynamically (EXECUTE) so that
-- storage.objects / storage.foldername() are never parsed on a vanilla-
-- Postgres validation harness where they do not exist.
--
--   face-enrolment-captures : NO policy for anon/authenticated AT ALL.
--                             Service-role key only (structural, not policy).
--   signatures              : NO policy for anon/authenticated. Service role
--                             writes; reads happen only in document rendering.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Buckets
-- -----------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    RAISE NOTICE 'storage schema unavailable (vanilla Postgres) — buckets skipped';
    RETURN;
  END IF;

  EXECUTE $sql$
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
      ('employee-photos',         'employee-photos',         false, 2097152, ARRAY['image/jpeg','image/png','image/webp']),
      ('face-enrolment-captures', 'face-enrolment-captures', false, NULL,    ARRAY['image/jpeg','image/png','image/webp']),
      ('kiosk-punch-photos',      'kiosk-punch-photos',      false, NULL,    ARRAY['image/jpeg','image/png','image/webp']),
      ('documents',               'documents',               false, NULL,    NULL),
      ('payslips',                'payslips',                false, NULL,    ARRAY['application/pdf']),
      ('contracts',               'contracts',               false, NULL,    ARRAY['application/pdf']),
      ('communications',          'communications',          false, NULL,    NULL),
      ('brand',                   'brand',                   true,  NULL,    NULL),
      ('imports',                 'imports',                 false, NULL,    NULL),
      ('exports',                 'exports',                 false, NULL,    NULL),
      ('signatures',              'signatures',              false, NULL,    ARRAY['image/png']),
      ('archive',                 'archive',                 false, NULL,    NULL)
    ON CONFLICT (id) DO UPDATE SET
      public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types
  $sql$;
END;
$do$;

-- -----------------------------------------------------------------------------
-- 2. storage.objects policies
-- -----------------------------------------------------------------------------

DO $do$
DECLARE
  v_stmt text;
  v_stmts text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    RAISE NOTICE 'storage schema unavailable (vanilla Postgres) — object policies skipped';
    RETURN;
  END IF;

  v_stmts := ARRAY[

    -- ── employee-photos ─ owner writes/reads/replaces own folder; admin all ──
    $sql$DROP POLICY IF EXISTS employee_photos__own_write ON storage.objects$sql$,
    $sql$CREATE POLICY employee_photos__own_write ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'employee-photos'
        AND (storage.foldername(name))[1] = app.current_employee_id()::text
      )$sql$,

    $sql$DROP POLICY IF EXISTS employee_photos__own_read ON storage.objects$sql$,
    $sql$CREATE POLICY employee_photos__own_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'employee-photos'
        AND (storage.foldername(name))[1] = app.current_employee_id()::text
      )$sql$,

    $sql$DROP POLICY IF EXISTS employee_photos__own_update ON storage.objects$sql$,
    $sql$CREATE POLICY employee_photos__own_update ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'employee-photos'
        AND (storage.foldername(name))[1] = app.current_employee_id()::text
      )
      WITH CHECK (
        bucket_id = 'employee-photos'
        AND (storage.foldername(name))[1] = app.current_employee_id()::text
      )$sql$,

    $sql$DROP POLICY IF EXISTS employee_photos__own_delete ON storage.objects$sql$,
    $sql$CREATE POLICY employee_photos__own_delete ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'employee-photos'
        AND (storage.foldername(name))[1] = app.current_employee_id()::text
      )$sql$,

    $sql$DROP POLICY IF EXISTS employee_photos__admin_all ON storage.objects$sql$,
    $sql$CREATE POLICY employee_photos__admin_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'employee-photos' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'employee-photos' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── face-enrolment-captures: deliberately NO policy. Service role only. ──

    -- ── kiosk-punch-photos ─ employee may view their own punch photos ────────
    -- (transparency). Service role writes; admin reads via 60 s signed URL
    -- minted by an edge function that also writes data_access_log.
    $sql$DROP POLICY IF EXISTS kiosk_punch_photos__own_read ON storage.objects$sql$,
    $sql$CREATE POLICY kiosk_punch_photos__own_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'kiosk-punch-photos'
        AND EXISTS (
          SELECT 1
          FROM public.attendance_punches ap
          WHERE ap.employee_id = app.current_employee_id()
            AND ap.photo_path = objects.name
        )
      )$sql$,

    -- ── documents ─ owner writes into own folder; admin all. Reads via the ───
    -- document-access edge function (5-min signed URL + document_access_log).
    $sql$DROP POLICY IF EXISTS documents__own_write ON storage.objects$sql$,
    $sql$CREATE POLICY documents__own_write ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[2] = app.current_employee_id()::text
      )$sql$,

    $sql$DROP POLICY IF EXISTS documents__admin_all ON storage.objects$sql$,
    $sql$CREATE POLICY documents__admin_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'documents' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'documents' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── payslips ─ employee reads own ONLY once the run is approved ──────────
    -- Path: <company_id>/<financial_year>/<employee_code>/<payslip_number>.pdf
    $sql$DROP POLICY IF EXISTS payslips__own_read ON storage.objects$sql$,
    $sql$CREATE POLICY payslips__own_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'payslips'
        AND EXISTS (
          SELECT 1
          FROM public.payslips p
          JOIN public.payroll_runs r ON r.id = p.payroll_run_id
          JOIN public.employees   e ON e.id = p.employee_id
          WHERE p.employee_id = app.current_employee_id()
            AND (storage.foldername(objects.name))[3] = e.employee_code
            AND r.status IN ('approved','disbursement_pending','paid','closed')
        )
      )$sql$,

    $sql$DROP POLICY IF EXISTS payslips__admin_read ON storage.objects$sql$,
    $sql$CREATE POLICY payslips__admin_read ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'payslips' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── contracts ─ employee reads own signed copy; admin all. Signers use ───
    -- the tokenised e-sign edge function (no direct policy).
    $sql$DROP POLICY IF EXISTS contracts__own_signed_read ON storage.objects$sql$,
    $sql$CREATE POLICY contracts__own_signed_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'contracts'
        AND position('/signed/' IN objects.name) > 0
        AND EXISTS (
          SELECT 1
          FROM public.contracts c
          WHERE c.employee_id = app.current_employee_id()
            AND storage.filename(objects.name) = c.contract_number || '.pdf'
        )
      )$sql$,

    $sql$DROP POLICY IF EXISTS contracts__admin_all ON storage.objects$sql$,
    $sql$CREATE POLICY contracts__admin_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'contracts' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'contracts' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── communications ─ recipients read attachments; admin all ──────────────
    -- Path: <communication_id>/<file>
    $sql$DROP POLICY IF EXISTS communications__recipient_read ON storage.objects$sql$,
    $sql$CREATE POLICY communications__recipient_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'communications'
        AND EXISTS (
          SELECT 1
          FROM public.communication_recipients cr
          WHERE cr.employee_id = app.current_employee_id()
            AND cr.communication_id::text = (storage.foldername(objects.name))[1]
        )
      )$sql$,

    $sql$DROP POLICY IF EXISTS communications__admin_all ON storage.objects$sql$,
    $sql$CREATE POLICY communications__admin_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'communications' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'communications' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── brand ─ the only public bucket: world read, admin write ──────────────
    $sql$DROP POLICY IF EXISTS brand__public_read ON storage.objects$sql$,
    $sql$CREATE POLICY brand__public_read ON storage.objects
      FOR SELECT TO anon, authenticated
      USING (bucket_id = 'brand')$sql$,

    $sql$DROP POLICY IF EXISTS brand__admin_write ON storage.objects$sql$,
    $sql$CREATE POLICY brand__admin_write ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'brand' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'brand' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── imports ─ admin only (spreadsheet PII) ───────────────────────────────
    $sql$DROP POLICY IF EXISTS imports__admin_all ON storage.objects$sql$,
    $sql$CREATE POLICY imports__admin_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'imports' AND (app.is_admin() OR app.is_super_admin()))
      WITH CHECK (bucket_id = 'imports' AND (app.is_admin() OR app.is_super_admin()))$sql$,

    -- ── exports ─ creator + super-admin only ─────────────────────────────────
    -- Path: <export_log_id>/<file>
    $sql$DROP POLICY IF EXISTS exports__creator_read ON storage.objects$sql$,
    $sql$CREATE POLICY exports__creator_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'exports'
        AND (
          app.is_super_admin()
          OR EXISTS (
            SELECT 1
            FROM public.export_log el
            WHERE el.id::text = (storage.foldername(objects.name))[1]
              AND el.actor_id = app.ctx_actor_id()
          )
        )
      )$sql$,

    -- ── signatures: deliberately NO policy. Service role only. ───────────────

    -- ── archive ─ super-admin only ───────────────────────────────────────────
    $sql$DROP POLICY IF EXISTS archive__super_admin_read ON storage.objects$sql$,
    $sql$CREATE POLICY archive__super_admin_read ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'archive' AND app.is_super_admin())$sql$
  ];

  FOREACH v_stmt IN ARRAY v_stmts LOOP
    BEGIN
      EXECUTE v_stmt;
    EXCEPTION
      WHEN insufficient_privilege THEN
        -- Hosted projects where storage.objects is owned by supabase_storage_admin
        -- and the migration role cannot manage policies: surface loudly, do not
        -- fail the whole migration (policies are then applied via the dashboard
        -- / storage API as an ops step).
        RAISE WARNING 'insufficient privilege for: %', left(v_stmt, 80);
    END;
  END LOOP;
END;
$do$;

COMMIT;
