-- =============================================================================
-- Migration 060 — seed the three surfaces that were still completely empty.
--
-- WHY THIS EXISTS
-- ---------------
-- A live probe against the deployed database (as the admin persona, through
-- RLS) found these counts:
--
--     documents                    0      document_versions          0
--     document_acknowledgements    0      contract_templates         0
--     communications               0      communication_events       0
--     communication_recipients     0      employee_custom_field_defs 0
--     employee_custom_field_values 0
--
-- Roughly seventeen route pages read nothing but those tables — the whole
-- /admin/documents group (8 routes), the whole /admin/comms group (7), plus
-- /me/documents, /me/profile/documents and /me/profile/custom. Every one of
-- them renders a correct, well-built EmptyState, which is exactly why the
-- screens "don't work" from a demo standpoint: the code is fine, the data is
-- absent. Seeding is the fix, not more UI.
--
-- SAFETY (identical contract to 047/052/053/054)
-- ---------------------------------------------
--  * Guarded by settings.seed_demo_data — flag not true ⇒ whole thing no-ops.
--  * Idempotent — every insert is existence-guarded, so re-running is inert.
--  * Deterministic — no random(). Values derive from employee_code ordinals and
--    date arithmetic, so a rebuild reproduces the identical demo.
--
-- SCHEMA FACTS THIS FILE WAS WRITTEN AGAINST (each verified, not assumed)
-- ----------------------------------------------------------------------
--  * documents.subject_kind        ∈ employee|company|policy|asset|payroll_run|event|vendor
--  * documents.virus_scan_status   ∈ pending|clean|infected|skipped
--  * document_status enum          ∈ draft|pending_review|approved|rejected|expired|superseded|archived
--  * ck_da__status                 ∈ assigned|opened|acknowledged|overdue|waived
--  * communications.status         ∈ draft|scheduled|sending|sent|partially_failed|cancelled
--  * communications.communication_kind ∈ policy|circular|payslip|offer|onboarding|survey|reminder|custom
--  * communications.send_mode      ∈ immediate|scheduled|drip  (+ scheduled REQUIRES scheduled_at)
--  * notification_channel enum     ∈ in_app|email|sms|whatsapp|push|kiosk_display
--  * notification_status enum      ∈ queued|sending|sent|delivered|opened|clicked|failed|bounced|suppressed|cancelled
--  * custom_field_type enum        ∈ text|number|date|boolean|single_select|multi_select|employee_ref|file
--  * communications.communication_number is NOT NULL, UNIQUE, and has NO
--    generator (unlike approval_requests, which has create_approval_request()
--    and seq_approval_request_number). It is minted here explicitly.
--  * ck_ecfv__one_value — employee_custom_field_values must set EXACTLY ONE of
--    value_text/number/date/boolean/json/document_id. Not zero, not two.
--  * ck_communication_recipients__mobile — '^[6-9][0-9]{9}$', ten digits, no +91.
--  * documents.uploaded_by → public.profiles(id), NOT auth.users.
--  * employees has NO full_name column — it is first_name/middle_name/last_name
--    plus a NOT NULL display_name. Use display_name.
--  * The joining date column is date_of_join, NOT date_of_joining.
--  * ck_ecfd__code — custom field codes must match '^[A-Z][A-Z0-9_]{1,63}$',
--    i.e. UPPER_SNAKE. Lower-case codes are rejected.
--  * trg_ecfv__validate checks `o->>'value' = NEW.value_text`, so a select
--    field's options must be an array of {value,label} OBJECTS. A bare string
--    array passes ck_ecfd__options (it only checks jsonb_typeof = 'array') and
--    then rejects every single value at insert time.
--  * row_number() is BIGINT and there is no `date - bigint` operator — every
--    date arithmetic involving an ordinal needs an explicit ::integer.
--  * ck_documents__file_size — file_size_bytes > 0, so no zero-byte placeholders.
--  * ck_contract_templates__contract_kind ∈ employment_permanent|employment_probation|
--    fixed_term|internship|consultant|retainer|casual_daily_wage|nda|non_compete|
--    training_bond. NOT 'offer'/'employment' — those look obvious and are wrong.
--
-- KNOWN LIMITATION, STATED PLAINLY
-- --------------------------------
-- No storage bucket is created by any migration, and these rows describe files
-- that were never uploaded. Document LISTS, filters, expiry warnings, version
-- history and acknowledgement tracking are all fully live; clicking "download"
-- on a seeded document will fail because the object does not exist in storage.
-- That is a deliberate trade: the metadata surfaces are what the demo shows.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 060: seed documents, communications and custom fields — the three surfaces still rendering empty', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled  boolean;
  v_company  uuid;
  v_actor    uuid;
  v_today    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_doc      uuid;
  v_comm     uuid;
  v_def      uuid;
  v_emp      record;
  v_n        integer;
  v_recips   integer;
  v_opened   integer;
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 060 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  SELECT id INTO v_company FROM public.companies ORDER BY created_at LIMIT 1;
  SELECT id INTO v_actor   FROM public.profiles  ORDER BY created_at LIMIT 1;
  IF v_company IS NULL OR v_actor IS NULL THEN
    RAISE NOTICE 'seed 060 skipped: no company or no profile';
    RETURN;
  END IF;

  -- ===========================================================================
  -- 1. Contract templates — what /admin/documents/templates reads.
  -- ===========================================================================
  INSERT INTO public.contract_templates
    (company_id, code, name, description, contract_kind, body_markdown,
     governing_law, jurisdiction, requires_witness, is_published, published_by,
     published_at, version, sort_order, created_by, updated_by)
  SELECT v_company, t.code, t.name, t.description, t.kind, t.body,
         'Laws of India', 'Bengaluru', t.witness, true, v_actor,
         now() - interval '90 days', 1, t.sort, v_actor, v_actor
    FROM (VALUES
      ('OFFER_STD',    'Standard Offer Letter',        'Offer letter for permanent venue staff.',
       'employment_probation',
       E'# Offer of Employment\n\nDear {{employee_name}},\n\nWe are pleased to offer you the position of **{{designation}}** at The Tamarind Tree, Bengaluru, reporting to {{manager_name}}.\n\nYour date of joining will be {{date_of_joining}} and your gross annual compensation will be {{ctc}}.\n\nThis offer is subject to satisfactory police verification and receipt of the documents listed in Annexure A.\n\nFor Machani Hospitalities LLP', false, 10),
      ('CONTRACT_PERM', 'Permanent Employment Contract', 'Full contract for confirmed employees.',
       'employment_permanent',
       E'# Employment Agreement\n\nThis agreement is made on {{contract_date}} between Machani Hospitalities LLP (LLPIN AAF-9371) and {{employee_name}}.\n\n## 1. Role\nThe employee is engaged as {{designation}} in the {{department}} department.\n\n## 2. Hours\nAs per the attendance policy applicable to the employee, including the event-day roster of the venue.\n\n## 3. Confidentiality\nThe employee shall not disclose guest or event information.\n\n## 4. Termination\nEither party may terminate on {{notice_period}} written notice.', true, 20),
      ('NDA_STD',      'Non-Disclosure Agreement',     'Guest-privacy NDA — required for all event-facing staff.',
       'nda',
       E'# Non-Disclosure Agreement\n\n{{employee_name}} acknowledges that in the course of employment at The Tamarind Tree they will learn the identity, contact details and event particulars of guests.\n\nThe employee agrees not to photograph, publish or discuss any guest or event, on social media or otherwise, during or after employment.\n\nBreach of this clause is treated as gross misconduct.', true, 30)
    ) AS t(code, name, description, kind, body, witness, sort)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.contract_templates ct
      WHERE ct.company_id = v_company AND ct.code = t.code);

  -- ===========================================================================
  -- 2. Company compliance documents — the venue's licences.
  --    These carry expiry_date, which is what the compliance/expiring views
  --    surface and what HR actually chases at a heritage venue.
  -- ===========================================================================
  FOR v_emp IN
    SELECT * FROM (VALUES
      ('FSSAI_CERT',        'FSSAI Licence — The Tamarind Tree Kitchen', 'fssai-licence-2026.pdf',  412_336, 118,  47),
      ('FIRE_SAFETY_CERT',  'Fire Safety Clearance — Banquet Hall',      'fire-noc-2026.pdf',       268_914, 205,  9),
      ('POLICE_VERIFICATION','Police Verification — Security Vendor',    'police-verif-vendor.pdf', 191_002, 320, 274)
    ) AS c(code, title, file_name, bytes, issued_days_ago, expires_in_days)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.documents d
                    WHERE d.company_id = v_company AND d.title = v_emp.title) THEN
      INSERT INTO public.documents
        (document_type_id, company_id, subject_kind, employee_id, title, file_name,
         storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
         page_count, current_version, status, issue_date, expiry_date,
         uploaded_by, uploaded_at, reviewed_by, reviewed_at,
         virus_scan_status, tags, is_confidential, created_by, updated_by)
      SELECT dt.id, v_company, 'company', NULL, v_emp.title, v_emp.file_name,
             'company-documents',
             'company/compliance/' || lower(v_emp.code) || '/' || v_emp.file_name,
             'application/pdf', v_emp.bytes,
             encode(extensions.digest(v_emp.file_name || v_emp.code, 'sha256'), 'hex'),
             2, 1, 'approved',
             v_today - v_emp.issued_days_ago,
             v_today + v_emp.expires_in_days,
             v_actor, now() - make_interval(days => v_emp.issued_days_ago),
             v_actor, now() - make_interval(days => v_emp.issued_days_ago - 1),
             'clean', ARRAY['compliance','licence'], false, v_actor, v_actor
        FROM public.document_types dt
       WHERE dt.code = v_emp.code
       LIMIT 1;
    END IF;
  END LOOP;

  -- ===========================================================================
  -- 3. Policy documents requiring acknowledgement.
  --    Drives /admin/documents/acknowledgements and /me/documents.
  -- ===========================================================================
  FOR v_emp IN
    SELECT * FROM (VALUES
      ('POLICY', 'Leave & Attendance Policy 2026',      'leave-attendance-policy-2026.pdf', 331_180, 14, 6),
      ('POLICY', 'Guest Privacy & Social Media Policy', 'guest-privacy-policy.pdf',         204_559, 30, 21),
      ('SOP',    'Banquet Service SOP — Event Days',    'banquet-service-sop.pdf',          512_744, 45, 12)
    ) AS p(code, title, file_name, bytes, published_days_ago, ack_due_in_days)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.documents d
                    WHERE d.company_id = v_company AND d.title = v_emp.title) THEN
      INSERT INTO public.documents
        (document_type_id, company_id, subject_kind, employee_id, title, file_name,
         storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
         page_count, current_version, status, issue_date,
         uploaded_by, uploaded_at, reviewed_by, reviewed_at,
         requires_acknowledgement, acknowledgement_due_on,
         virus_scan_status, tags, is_confidential, created_by, updated_by)
      SELECT dt.id, v_company, 'policy', NULL, v_emp.title, v_emp.file_name,
             'company-documents',
             'company/policy/' || v_emp.file_name,
             'application/pdf', v_emp.bytes,
             encode(extensions.digest(v_emp.file_name, 'sha256'), 'hex'),
             4, 1, 'approved',
             v_today - v_emp.published_days_ago,
             v_actor, now() - make_interval(days => v_emp.published_days_ago),
             v_actor, now() - make_interval(days => v_emp.published_days_ago),
             true, v_today + v_emp.ack_due_in_days,
             'clean', ARRAY['policy'], false, v_actor, v_actor
        FROM public.document_types dt
       WHERE dt.code = v_emp.code
       LIMIT 1;
    END IF;
  END LOOP;

  -- ===========================================================================
  -- 4. Per-employee documents: offer letter, contract, Aadhaar, PAN.
  --    Two employees deliberately MISS their PAN so the "missing documents"
  --    compliance view has something real to report.
  -- ===========================================================================
  v_n := 0;
  FOR v_emp IN
    SELECT e.id, e.employee_code, e.display_name, e.date_of_join,
           row_number() OVER (ORDER BY e.employee_code) AS rn
      FROM public.employees e
     WHERE e.deleted_at IS NULL
     ORDER BY e.employee_code
  LOOP
    -- Offer letter + contract for everyone; identity proofs for most.
    INSERT INTO public.documents
      (document_type_id, company_id, subject_kind, employee_id, title, file_name,
       storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
       page_count, current_version, status, issue_date,
       uploaded_by, uploaded_at, virus_scan_status, tags,
       is_confidential, is_system_generated, created_by, updated_by)
    SELECT dt.id, v_company, 'employee', v_emp.id,
           d.label || ' — ' || v_emp.display_name,
           lower(v_emp.employee_code) || '-' || d.slug || '.pdf',
           'employee-documents',
           'employee/' || v_emp.employee_code || '/' || d.slug || '.pdf',
           'application/pdf',
           120_000 + (v_emp.rn * 3_137) + d.extra,
           encode(extensions.digest(v_emp.employee_code || d.slug, 'sha256'), 'hex'),
           d.pages, 1, 'approved',
           COALESCE(v_emp.date_of_join, v_today - 200) - d.days_before_joining,
           v_actor,
           (COALESCE(v_emp.date_of_join, v_today - 200) - d.days_before_joining)::timestamptz + interval '11 hours',
           'clean', d.tags, d.confidential, d.system_gen, v_actor, v_actor
      FROM public.document_types dt
      JOIN (VALUES
        ('OFFER_LETTER', 'Offer Letter',   'offer-letter', 2,  1_209, 14, ARRAY['employment'], false, true),
        ('CONTRACT',     'Employment Contract', 'contract', 6, 4_411, 0,  ARRAY['employment'], false, true),
        ('AADHAAR',      'Aadhaar Card',   'aadhaar',      1,    877, 20, ARRAY['identity','kyc'], true, false),
        ('PAN',          'PAN Card',       'pan',          1,    602, 20, ARRAY['identity','kyc'], true, false)
      ) AS d(type_code, label, slug, pages, extra, days_before_joining, tags, confidential, system_gen)
        ON dt.code = d.type_code
     WHERE NOT (d.type_code = 'PAN' AND v_emp.rn % 7 = 3)   -- deliberate gap
       AND NOT EXISTS (
         SELECT 1 FROM public.documents x
          WHERE x.employee_id = v_emp.id AND x.document_type_id = dt.id);

    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'seed 060: employee documents ensured for % employees', v_n;

  -- ===========================================================================
  -- 5. document_versions — v1 current for every document, plus a genuine v2 on
  --    the leave policy so version history has something to show.
  -- ===========================================================================
  INSERT INTO public.document_versions
    (document_id, version, storage_path, file_name, file_size_bytes,
     checksum_sha256, mime_type, page_count, uploaded_by, uploaded_at,
     is_current, created_by, updated_by)
  SELECT d.id, 1, d.storage_path, d.file_name, d.file_size_bytes,
         d.checksum_sha256, d.mime_type, d.page_count, d.uploaded_by,
         d.uploaded_at, (d.current_version = 1), v_actor, v_actor
    FROM public.documents d
   WHERE d.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.document_versions v
                      WHERE v.document_id = d.id AND v.version = 1);

  -- Supersede the leave policy with a v2 (the realistic case: a re-issue).
  SELECT id INTO v_doc FROM public.documents
   WHERE company_id = v_company AND title = 'Leave & Attendance Policy 2026'
   LIMIT 1;
  IF v_doc IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.document_versions
                      WHERE document_id = v_doc AND version = 2) THEN
    UPDATE public.document_versions
       SET is_current = false, replaced_reason = 'Superseded by v2 — comp-off expiry window corrected from 60 to 90 days.'
     WHERE document_id = v_doc AND version = 1;
    INSERT INTO public.document_versions
      (document_id, version, storage_path, file_name, file_size_bytes,
       checksum_sha256, mime_type, page_count, uploaded_by, uploaded_at,
       is_current, created_by, updated_by)
    SELECT v_doc, 2,
           'company/policy/leave-attendance-policy-2026-v2.pdf',
           'leave-attendance-policy-2026-v2.pdf',
           344_902,
           encode(extensions.digest('leave-attendance-policy-2026-v2', 'sha256'), 'hex'),
           'application/pdf', 4, v_actor, now() - interval '5 days',
           true, v_actor, v_actor;
    UPDATE public.documents
       SET current_version = 2, updated_by = v_actor
     WHERE id = v_doc;
  END IF;

  -- ===========================================================================
  -- 6. Acknowledgements — every ack-required policy assigned to every employee,
  --    with a realistic spread of states rather than all one value.
  -- ===========================================================================
  INSERT INTO public.document_acknowledgements
    (document_id, employee_id, assigned_at, due_on,
     first_opened_at, open_count, total_read_seconds, scroll_completion_pct,
     acknowledged_at, acknowledgement_text, status, reminder_count,
     created_by, updated_by)
  SELECT d.id, e.id,
         d.uploaded_at,
         d.acknowledgement_due_on,
         CASE WHEN s.bucket IN (0, 1, 2) THEN d.uploaded_at + interval '1 day' ELSE NULL END,
         CASE WHEN s.bucket IN (0, 1, 2) THEN 1 + s.bucket ELSE 0 END,
         CASE WHEN s.bucket IN (0, 1)    THEN 60 + s.bucket * 45 ELSE 0 END,
         CASE WHEN s.bucket = 0 THEN 100 WHEN s.bucket = 1 THEN 100 WHEN s.bucket = 2 THEN 38 ELSE 0 END,
         CASE WHEN s.bucket IN (0, 1) THEN d.uploaded_at + interval '2 days' ELSE NULL END,
         CASE WHEN s.bucket IN (0, 1) THEN 'I have read and understood this policy.' ELSE NULL END,
         CASE s.bucket WHEN 0 THEN 'acknowledged' WHEN 1 THEN 'acknowledged'
                       WHEN 2 THEN 'opened'
                       WHEN 3 THEN CASE WHEN d.acknowledgement_due_on < v_today THEN 'overdue' ELSE 'assigned' END
                       ELSE 'assigned' END,
         CASE WHEN s.bucket = 3 THEN 2 ELSE 0 END,
         v_actor, v_actor
    FROM public.documents d
    CROSS JOIN LATERAL (
      SELECT e2.id, row_number() OVER (ORDER BY e2.employee_code) AS rn
        FROM public.employees e2
       WHERE e2.deleted_at IS NULL
    ) e
    CROSS JOIN LATERAL (SELECT (e.rn + length(d.title)) % 5 AS bucket) s
   WHERE d.requires_acknowledgement
     AND d.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.document_acknowledgements a
                      WHERE a.document_id = d.id AND a.employee_id = e.id);

  -- ===========================================================================
  -- 7. Communications — the /admin/comms group.
  --    communication_number has no generator, so mint it deterministically.
  -- ===========================================================================
  FOR v_emp IN
    SELECT * FROM (VALUES
      (1, 'Leave & Attendance Policy 2026 — please acknowledge', 'policy',   'sent',      'immediate', 14, true),
      (2, 'March 2026 payslips are now available',               'payslip',  'sent',      'immediate',  6, false),
      (3, 'Republic Day event roster — confirm your shift',       'circular', 'sent',      'immediate',  3, false),
      (4, 'Reminder: complete your KYC documents',               'reminder', 'scheduled', 'scheduled', -2, false),
      (5, 'Staff satisfaction survey (draft)',                   'survey',   'draft',     'immediate',  0, false)
    ) AS c(seq, subject, kind, status, mode, days_ago, needs_signing)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.communications
                    WHERE company_id = v_company
                      AND communication_number = 'TT-COM-2026-' || lpad(v_emp.seq::text, 4, '0')) THEN

      SELECT count(*) INTO v_recips FROM public.employees WHERE deleted_at IS NULL;
      v_opened := GREATEST(0, v_recips - 4);

      INSERT INTO public.communications
        (communication_number, company_id, subject, body_text, body_html,
         communication_kind, channels, requires_signing, send_mode,
         scheduled_at, sent_at, status,
         recipient_count, delivered_count, opened_count, signed_count, failed_count,
         from_name, from_email, reply_to, approved_by, approved_at,
         created_by, updated_by)
      VALUES (
        'TT-COM-2026-' || lpad(v_emp.seq::text, 4, '0'),
        v_company, v_emp.subject,
        'Dear colleague,' || E'\n\n' || v_emp.subject || E'\n\n' ||
          'Please log in to the HRMS to view the details.' || E'\n\n' ||
          'The Tamarind Tree — People team',
        '<p>Dear colleague,</p><p>' || v_emp.subject ||
          '</p><p>Please log in to the HRMS to view the details.</p>' ||
          '<p>The Tamarind Tree — People team</p>',
        v_emp.kind,
        CASE WHEN v_emp.kind = 'circular'
             THEN ARRAY['email','in_app','whatsapp']::public.notification_channel[]
             ELSE ARRAY['email','in_app']::public.notification_channel[] END,
        v_emp.needs_signing,
        v_emp.mode,
        CASE WHEN v_emp.mode = 'scheduled'
             THEN now() + make_interval(days => abs(v_emp.days_ago)) ELSE NULL END,
        CASE WHEN v_emp.status = 'sent'
             THEN now() - make_interval(days => v_emp.days_ago) ELSE NULL END,
        v_emp.status,
        CASE WHEN v_emp.status = 'sent' THEN v_recips ELSE 0 END,
        CASE WHEN v_emp.status = 'sent' THEN v_recips - 1 ELSE 0 END,
        CASE WHEN v_emp.status = 'sent' THEN v_opened ELSE 0 END,
        CASE WHEN v_emp.status = 'sent' AND v_emp.needs_signing THEN GREATEST(0, v_recips - 6) ELSE 0 END,
        CASE WHEN v_emp.status = 'sent' THEN 1 ELSE 0 END,
        'The Tamarind Tree', 'onboarding@resend.dev', 'onboarding@resend.dev',
        CASE WHEN v_emp.status = 'sent' THEN v_actor ELSE NULL END,
        CASE WHEN v_emp.status = 'sent' THEN now() - make_interval(days => v_emp.days_ago + 1) ELSE NULL END,
        v_actor, v_actor)
      RETURNING id INTO v_comm;

      -- Recipients, only for things actually sent.
      IF v_emp.status = 'sent' THEN
        WITH ranked AS (
          SELECT e.id,
                 e.employee_code,
                 COALESCE(e.work_email,
                          'staff+' || lower(e.employee_code) || '@tamarindtree.example') AS email,
                 row_number() OVER (ORDER BY e.employee_code) AS rn
            FROM public.employees e
           WHERE e.deleted_at IS NULL)
        INSERT INTO public.communication_recipients
          (communication_id, employee_id, email, mobile, slug, status,
           sent_at, delivered_at, first_opened_at, open_count, last_opened_at,
           signed_at, bounce_kind, failure_detail, created_by, updated_by)
        SELECT v_comm, r.id, r.email, NULL,
               -- uq_cr__slug is GLOBAL, not per-communication, so the sequence
               -- number has to be part of it.
               lower(r.employee_code) || '-c' || v_emp.seq,
               CASE WHEN r.rn = 1              THEN 'bounced'::public.notification_status
                    WHEN r.rn <= v_opened      THEN 'opened'::public.notification_status
                    ELSE 'delivered'::public.notification_status END,
               now() - make_interval(days => v_emp.days_ago),
               CASE WHEN r.rn > 1
                    THEN now() - make_interval(days => v_emp.days_ago) + interval '4 minutes' END,
               CASE WHEN r.rn > 1 AND r.rn <= v_opened
                    THEN now() - make_interval(days => v_emp.days_ago) + interval '3 hours' END,
               CASE WHEN r.rn > 1 AND r.rn <= v_opened THEN 1 ELSE 0 END,
               CASE WHEN r.rn > 1 AND r.rn <= v_opened
                    THEN now() - make_interval(days => v_emp.days_ago) + interval '3 hours' END,
               CASE WHEN v_emp.needs_signing AND r.rn > 6
                    THEN now() - make_interval(days => v_emp.days_ago) + interval '1 day' END,
               CASE WHEN r.rn = 1 THEN 'hard' END,
               CASE WHEN r.rn = 1 THEN 'Recipient address does not exist (550)' END,
               v_actor, v_actor
          FROM ranked r;

        -- Provider events for the delivery timeline.
        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, payload, occurred_at, recorded_by)
        SELECT v_comm, cr.id, ev.event, 'resend',
               jsonb_build_object('seeded', true, 'slug', cr.slug),
               now() - make_interval(days => v_emp.days_ago) + ev.offset_int,
               v_actor
          FROM public.communication_recipients cr
          CROSS JOIN LATERAL (VALUES
            ('queued',    interval '0 minutes'),
            ('sent',      interval '1 minute'),
            ('delivered', interval '4 minutes')
          ) AS ev(event, offset_int)
         WHERE cr.communication_id = v_comm
           AND cr.status <> 'bounced'
           AND NOT EXISTS (SELECT 1 FROM public.communication_events x
                            WHERE x.recipient_id = cr.id AND x.event = ev.event);

        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, payload, occurred_at, recorded_by)
        SELECT v_comm, cr.id, 'bounced', 'resend',
               jsonb_build_object('seeded', true, 'reason', 'mailbox_not_found'),
               now() - make_interval(days => v_emp.days_ago) + interval '2 minutes',
               v_actor
          FROM public.communication_recipients cr
         WHERE cr.communication_id = v_comm AND cr.status = 'bounced';

        INSERT INTO public.communication_events
          (communication_id, recipient_id, event, provider, payload, occurred_at, recorded_by)
        SELECT v_comm, cr.id, 'opened', 'resend',
               jsonb_build_object('seeded', true),
               cr.first_opened_at, v_actor
          FROM public.communication_recipients cr
         WHERE cr.communication_id = v_comm
           AND cr.first_opened_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.communication_events x
                            WHERE x.recipient_id = cr.id AND x.event = 'opened');
      END IF;
    END IF;
  END LOOP;

  -- ===========================================================================
  -- 8. Venue-specific custom fields — /me/profile/custom and
  --    /admin/org/custom-fields. These are the fields a wedding venue really
  --    keeps, which is what makes the demo read as domain-aware.
  -- ===========================================================================
  FOR v_emp IN
    SELECT * FROM (VALUES
      ('UNIFORM_SIZE',    'Uniform size',            'single_select', 'additional', false, true,  false, 10,
       '[{"value": "XS", "label": "XS"}, {"value": "S", "label": "S"}, {"value": "M", "label": "M"}, {"value": "L", "label": "L"}, {"value": "XL", "label": "XL"}, {"value": "XXL", "label": "XXL"}]'::jsonb),
      ('SHOE_SIZE',       'Safety shoe size (UK)',   'number',        'additional', false, true,  false, 20, NULL::jsonb),
      ('TRANSPORT_ROUTE', 'Staff transport route',   'single_select', 'logistics',  false, true,  false, 30,
       '[{"value": "Route A \u2014 Whitefield", "label": "Route A \u2014 Whitefield"}, {"value": "Route B \u2014 Sarjapur", "label": "Route B \u2014 Sarjapur"}, {"value": "Route C \u2014 Yelahanka", "label": "Route C \u2014 Yelahanka"}, {"value": "Own transport", "label": "Own transport"}]'::jsonb),
      ('FOOD_PREFERENCE', 'Meal preference',         'single_select', 'logistics',  false, true,  false, 40,
       '[{"value": "Vegetarian", "label": "Vegetarian"}, {"value": "Non-vegetarian", "label": "Non-vegetarian"}, {"value": "Jain", "label": "Jain"}, {"value": "Vegan", "label": "Vegan"}]'::jsonb),
      ('LOCKER_NUMBER',   'Locker number',           'text',          'logistics',  false, false, false, 50, NULL::jsonb),
      ('BLOOD_GROUP',     'Blood group',             'single_select', 'medical',    false, true,  true,  60,
       '[{"value": "A+", "label": "A+"}, {"value": "A-", "label": "A-"}, {"value": "B+", "label": "B+"}, {"value": "B-", "label": "B-"}, {"value": "O+", "label": "O+"}, {"value": "O-", "label": "O-"}, {"value": "AB+", "label": "AB+"}, {"value": "AB-", "label": "AB-"}]'::jsonb),
      ('TWO_WHEELER',     'Holds a two-wheeler licence', 'boolean',   'additional', false, true,  false, 70, NULL::jsonb),
      ('EVENT_CERTIFIED', 'Banquet-service certified on', 'date',      'additional', false, false, false, 80, NULL::jsonb)
    ) AS f(code, label, ftype, section, required, employee_editable, pii, sort, options)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.employee_custom_field_defs
                    WHERE company_id = v_company AND code = v_emp.code) THEN
      INSERT INTO public.employee_custom_field_defs
        (company_id, code, label, help_text, field_type, options, is_required,
         is_employee_editable, requires_approval, is_pii, section, sort_order,
         is_active, created_by, updated_by)
      VALUES (v_company, v_emp.code, v_emp.label,
              CASE v_emp.code
                WHEN 'TRANSPORT_ROUTE' THEN 'Used to plan the staff bus on event days.'
                WHEN 'BLOOD_GROUP'     THEN 'Held for on-site medical emergencies only.'
                WHEN 'LOCKER_NUMBER'   THEN 'Assigned by the facilities team.'
                ELSE NULL END,
              v_emp.ftype::public.custom_field_type,
              v_emp.options, v_emp.required, v_emp.employee_editable,
              CASE WHEN v_emp.code IN ('BLOOD_GROUP','LOCKER_NUMBER') THEN true ELSE false END,
              v_emp.pii, v_emp.section, v_emp.sort, true, v_actor, v_actor);
    END IF;
  END LOOP;

  -- Values — exactly one value column per row (ck_ecfv__one_value).
  FOR v_emp IN
    SELECT e.id AS employee_id, row_number() OVER (ORDER BY e.employee_code) AS rn
      FROM public.employees e WHERE e.deleted_at IS NULL
  LOOP
    -- text / single_select values
    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'UNIFORM_SIZE' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_text, created_by, updated_by)
      SELECT v_emp.employee_id, v_def,
             (ARRAY['S','M','L','XL','M','L'])[1 + (v_emp.rn % 6)], v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'TRANSPORT_ROUTE' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_text, created_by, updated_by)
      SELECT v_emp.employee_id, v_def,
             (ARRAY['Route A — Whitefield','Route B — Sarjapur','Route C — Yelahanka','Own transport'])[1 + (v_emp.rn % 4)],
             v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'FOOD_PREFERENCE' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_text, created_by, updated_by)
      SELECT v_emp.employee_id, v_def,
             (ARRAY['Vegetarian','Non-vegetarian','Vegetarian','Jain'])[1 + (v_emp.rn % 4)], v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'BLOOD_GROUP' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_text, created_by, updated_by)
      SELECT v_emp.employee_id, v_def,
             (ARRAY['O+','B+','A+','AB+','O-','B+','A+','O+'])[1 + (v_emp.rn % 8)], v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    -- number
    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'SHOE_SIZE' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_number, created_by, updated_by)
      SELECT v_emp.employee_id, v_def, 5 + (v_emp.rn % 6), v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    -- boolean
    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'TWO_WHEELER' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_boolean, created_by, updated_by)
      SELECT v_emp.employee_id, v_def, (v_emp.rn % 3 <> 0), v_actor, v_actor
       WHERE NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;

    -- date — only for the two-thirds who are certified, so the field has real gaps
    FOR v_def IN
      SELECT id FROM public.employee_custom_field_defs
       WHERE company_id = v_company AND code = 'EVENT_CERTIFIED' AND deleted_at IS NULL
    LOOP
      INSERT INTO public.employee_custom_field_values
        (employee_id, field_def_id, value_date, created_by, updated_by)
      SELECT v_emp.employee_id, v_def,
             v_today - (40 + v_emp.rn * 11)::integer, v_actor, v_actor
       WHERE v_emp.rn % 3 <> 0
         AND NOT EXISTS (SELECT 1 FROM public.employee_custom_field_values
                          WHERE employee_id = v_emp.employee_id AND field_def_id = v_def);
    END LOOP;
  END LOOP;

  RAISE NOTICE 'seed 060 complete';
END
$seed$;

COMMIT;
