-- =============================================================================
-- Migration 027 — communications & notifications
-- Source: docs/plan/04-data-model.md §3.11 (lines 2338–2365); spec-migrations
--         §2 row 027. Tables: announcements, communications,
--         communication_recipients, communication_events,
--         notification_templates, notifications, notification_preferences.
--
-- Design notes:
--   * notification_templates is created before communications so
--     communications.template_id can carry its FK inline.
--   * communication_recipients.token_hash lives in
--     secure.communication_recipient_tokens per the doc's "(in secure)" note —
--     tokenised public read/sign links are secret material.
--   * notifications is partitioned RANGE (recorded_at) quarterly (§12.4), so
--     its PK is (id, recorded_at) and the doc's uq_notifications__dedupe is
--     created per partition (a partitioned unique index must include the
--     partition key, which would defeat the dedupe semantics).
--   * app.announcement_visible(uuid) (doc §3.11 RLS) is defined here — it is
--     not part of the 005 helper set.
-- Enums notification_channel / notification_status already exist (003).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. announcements — the noticeboard
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.announcements (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  title                     text        NOT NULL,
  body_markdown             text        NOT NULL,
  announcement_kind         text        NOT NULL DEFAULT 'general',
  priority                  text        NOT NULL DEFAULT 'normal',
  banner_image_path         text        NULL,
  publish_at                timestamptz NULL,
  expires_at                timestamptz NULL,
  audience                  jsonb       NOT NULL DEFAULT '{"all": true}',
  pinned                    boolean     NOT NULL DEFAULT false,
  requires_acknowledgement  boolean     NOT NULL DEFAULT false,
  document_id               uuid        NULL,
  published_by              uuid        NULL,
  published_at              timestamptz NULL,
  view_count                integer     NOT NULL DEFAULT 0,
  status                    text        NOT NULL DEFAULT 'draft',
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NULL,
  deleted_at                timestamptz NULL,
  deleted_by                uuid        NULL,
  deletion_reason           text        NULL,
  CONSTRAINT pk_announcements PRIMARY KEY (id),
  CONSTRAINT fk_announcements__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_announcements__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_announcements__published_by
    FOREIGN KEY (published_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_announcements__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_announcements__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_announcements__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_announcements__kind CHECK (announcement_kind IN
    ('general','policy_change','event_briefing','celebration','safety_alert',
     'roster_published','holiday_notice')),
  CONSTRAINT ck_announcements__priority CHECK (priority IN
    ('low','normal','high','critical')),
  CONSTRAINT ck_announcements__status CHECK (status IN
    ('draft','scheduled','published','archived')),
  CONSTRAINT ck_announcements__view_count CHECK (view_count >= 0),
  CONSTRAINT ck_announcements__audience CHECK (jsonb_typeof(audience) = 'object'),
  CONSTRAINT ck_announcements__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON COLUMN public.announcements.audience IS
  '{"all": true} or {department_ids: [...], location_ids: [...], employment_types: [...], employee_ids: [...]}.';

CREATE INDEX IF NOT EXISTS idx_announcements__status_publish
  ON public.announcements (status, publish_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_announcements__company_id ON public.announcements (company_id);
CREATE INDEX IF NOT EXISTS idx_announcements__document_id ON public.announcements (document_id);
CREATE INDEX IF NOT EXISTS idx_announcements__pinned
  ON public.announcements (pinned) WHERE pinned AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_announcements__stamp ON public.announcements;
CREATE TRIGGER trg_announcements__stamp
  BEFORE INSERT ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_announcements__touch ON public.announcements;
CREATE TRIGGER trg_announcements__touch
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Audience matcher used by the P7 read policy. SECURITY DEFINER so the check
-- can read announcements + employees without recursing into RLS.
CREATE OR REPLACE FUNCTION app.announcement_visible(p_announcement_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.announcements a
    LEFT JOIN public.employees e
      ON e.id = app.current_employee_id() AND e.deleted_at IS NULL
    WHERE a.id = p_announcement_id
      AND a.status = 'published'
      AND a.deleted_at IS NULL
      AND (a.publish_at IS NULL OR a.publish_at <= now())
      AND (a.expires_at IS NULL OR a.expires_at > now())
      AND (
        coalesce((a.audience ->> 'all')::boolean, false)
        OR (e.id IS NOT NULL AND (
             (a.audience ? 'department_ids'
                AND e.department_id IS NOT NULL
                AND a.audience -> 'department_ids' @> to_jsonb(e.department_id))
          OR (a.audience ? 'location_ids'
                AND e.location_id IS NOT NULL
                AND a.audience -> 'location_ids' @> to_jsonb(e.location_id))
          OR (a.audience ? 'employment_types'
                AND a.audience -> 'employment_types' @> to_jsonb(e.employment_type::text))
          OR (a.audience ? 'employee_ids'
                AND a.audience -> 'employee_ids' @> to_jsonb(e.id))))
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION app.announcement_visible(uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION app.announcement_visible(uuid) TO %I', v_role);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

-- P7: published + audience-matching.
DROP POLICY IF EXISTS announcements__audience__select ON public.announcements;
CREATE POLICY announcements__audience__select ON public.announcements
  FOR SELECT TO authenticated
  USING (app.announcement_visible(id));

-- Authors see their own drafts (a manager drafting a team briefing must be
-- able to read it back before it is published).
DROP POLICY IF EXISTS announcements__author__select ON public.announcements;
CREATE POLICY announcements__author__select ON public.announcements
  FOR SELECT TO authenticated
  USING (created_by = app.ctx_actor_id() AND deleted_at IS NULL);

-- §4.4 "I(team, if granted)": managers may draft; publishing stays with P8.
DROP POLICY IF EXISTS announcements__manager__insert ON public.announcements;
CREATE POLICY announcements__manager__insert ON public.announcements
  FOR INSERT TO authenticated
  WITH CHECK (app.is_manager() AND status = 'draft');

DROP POLICY IF EXISTS announcements__admin__all ON public.announcements;
CREATE POLICY announcements__admin__all ON public.announcements
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.announcements TO authenticated;
REVOKE DELETE ON public.announcements FROM authenticated;

-- -----------------------------------------------------------------------------
-- 2. notification_templates (lookup shape; one row per event code x channel)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_templates (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id               uuid        NOT NULL,
  code                     text        NOT NULL,
  name                     text        NOT NULL,
  description              text        NULL,
  sort_order               integer     NOT NULL DEFAULT 100,
  is_active                boolean     NOT NULL DEFAULT true,
  channel                  public.notification_channel NOT NULL,
  subject_template         text        NULL,
  body_template            text        NOT NULL,
  sms_template             text        NULL,
  dlt_template_id          text        NULL,
  whatsapp_template_name   text        NULL,
  variables                jsonb       NULL,
  locale                   text        NOT NULL DEFAULT 'en-IN',
  is_transactional         boolean     NOT NULL DEFAULT false,
  is_system                boolean     NOT NULL DEFAULT false,
  preview_data             jsonb       NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NULL,
  deleted_at               timestamptz NULL,
  deleted_by               uuid        NULL,
  deletion_reason          text        NULL,
  CONSTRAINT pk_notification_templates PRIMARY KEY (id),
  CONSTRAINT fk_notification_templates__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_notification_templates__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_templates__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_templates__deleted_by
    FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- TRAI/DLT: registered SMS copy is <=160 chars and carries its DLT id.
  CONSTRAINT ck_notification_templates__sms_length
    CHECK (sms_template IS NULL OR length(sms_template) <= 160),
  CONSTRAINT ck_notification_templates__deletion_reason CHECK (
    deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(deletion_reason)) >= 10))
);

COMMENT ON TABLE public.notification_templates IS
  'Seeded event codes (26): LEAVE_APPLIED, LEAVE_DECIDED, REGULARIZATION_APPLIED, REGULARIZATION_DECIDED, PUNCH_MISSING_OUT, NO_SHOW_ALERT, PAYSLIP_READY, SALARY_CREDITED, PROBATION_DUE, CONTRACT_EXPIRING, DOCUMENT_EXPIRING, LICENCE_EXPIRING, COMP_OFF_EXPIRING, LEAVE_BALANCE_LAPSING, BIRTHDAY, WORK_ANNIVERSARY, ROSTER_PUBLISHED, SHIFT_CHANGED, APPROVAL_PENDING, APPROVAL_SLA_BREACH, POLICY_ACK_DUE, ASSET_RETURN_DUE, KIOSK_OFFLINE, FACE_ENROLMENT_REQUIRED, PASSWORD_CHANGED, NEW_DEVICE_LOGIN. One row per (code, channel).';

-- Uniqueness is per company+code+CHANNEL: each event code seeds one in_app
-- row and one email row (plus sms for six codes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_templates__company_code_channel
  ON public.notification_templates (company_id, code, channel) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_templates__company_id
  ON public.notification_templates (company_id);

DROP TRIGGER IF EXISTS trg_notification_templates__stamp ON public.notification_templates;
CREATE TRIGGER trg_notification_templates__stamp
  BEFORE INSERT ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_notification_templates__touch ON public.notification_templates;
CREATE TRIGGER trg_notification_templates__touch
  BEFORE UPDATE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

-- P8 only (§4.4).
DROP POLICY IF EXISTS notification_templates__admin__all ON public.notification_templates;
CREATE POLICY notification_templates__admin__all ON public.notification_templates
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.notification_templates TO authenticated;
REVOKE DELETE ON public.notification_templates FROM authenticated;

-- -----------------------------------------------------------------------------
-- 3. communications — targeted, trackable sends
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.communications (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  communication_number     text        NOT NULL,
  company_id               uuid        NOT NULL,
  subject                  text        NOT NULL,
  body_html                text        NULL,
  body_text                text        NULL,
  template_id              uuid        NULL,
  communication_kind       text        NOT NULL DEFAULT 'custom',
  channels                 public.notification_channel[] NOT NULL,
  requires_signing         boolean     NOT NULL DEFAULT false,
  document_id              uuid        NULL,
  attachment_document_ids  uuid[]      NULL,
  send_mode                text        NOT NULL DEFAULT 'immediate',
  scheduled_at             timestamptz NULL,
  sent_at                  timestamptz NULL,
  status                   text        NOT NULL DEFAULT 'draft',
  recipient_count          integer     NOT NULL DEFAULT 0,
  delivered_count          integer     NOT NULL DEFAULT 0,
  opened_count             integer     NOT NULL DEFAULT 0,
  signed_count             integer     NOT NULL DEFAULT 0,
  failed_count             integer     NOT NULL DEFAULT 0,
  from_name                text        NULL,
  from_email               text        NULL,
  reply_to                 text        NULL,
  cc_emails                text[]      NULL,
  approved_by              uuid        NULL,
  approved_at              timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid        NULL,
  CONSTRAINT pk_communications PRIMARY KEY (id),
  CONSTRAINT fk_communications__company_id
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_communications__template_id
    FOREIGN KEY (template_id) REFERENCES public.notification_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_communications__document_id
    FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_communications__approved_by
    FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_communications__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_communications__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_communications__kind CHECK (communication_kind IN
    ('policy','circular','payslip','offer','onboarding','survey','reminder','custom')),
  CONSTRAINT ck_communications__send_mode CHECK (send_mode IN
    ('immediate','scheduled','drip')),
  CONSTRAINT ck_communications__status CHECK (status IN
    ('draft','scheduled','sending','sent','partially_failed','cancelled')),
  CONSTRAINT ck_communications__channels_nonempty CHECK (cardinality(channels) > 0),
  CONSTRAINT ck_communications__counts CHECK (
    recipient_count >= 0 AND delivered_count >= 0 AND opened_count >= 0
    AND signed_count >= 0 AND failed_count >= 0),
  CONSTRAINT ck_communications__from_email CHECK (
    from_email IS NULL OR from_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_communications__reply_to CHECK (
    reply_to IS NULL OR reply_to ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_communications__scheduled_needs_time CHECK (
    send_mode <> 'scheduled' OR status = 'draft' OR scheduled_at IS NOT NULL)
);

COMMENT ON TABLE public.communications IS
  'Targeted, trackable sends: policy circulation, offer emails, payslip mails. Distinct from the announcements noticeboard.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_communications__communication_number
  ON public.communications (communication_number);
CREATE INDEX IF NOT EXISTS idx_communications__company_id  ON public.communications (company_id);
CREATE INDEX IF NOT EXISTS idx_communications__template_id ON public.communications (template_id);
CREATE INDEX IF NOT EXISTS idx_communications__document_id ON public.communications (document_id);
CREATE INDEX IF NOT EXISTS idx_communications__status
  ON public.communications (status) WHERE status IN ('scheduled','sending');

DROP TRIGGER IF EXISTS trg_communications__stamp ON public.communications;
CREATE TRIGGER trg_communications__stamp
  BEFORE INSERT ON public.communications
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_communications__touch ON public.communications;
CREATE TRIGGER trg_communications__touch
  BEFORE UPDATE ON public.communications
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;

-- P8 only (§4.4: employees/managers never see the send console).
DROP POLICY IF EXISTS communications__admin__all ON public.communications;
CREATE POLICY communications__admin__all ON public.communications
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.communications TO authenticated;
REVOKE DELETE ON public.communications FROM authenticated;

-- -----------------------------------------------------------------------------
-- 4. communication_recipients (+ token hashes in secure)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.communication_recipients (
  id                           uuid        NOT NULL DEFAULT gen_random_uuid(),
  communication_id             uuid        NOT NULL,
  employee_id                  uuid        NULL,
  email                        text        NULL,
  mobile                       text        NULL,
  personalisation              jsonb       NULL,
  slug                         text        NOT NULL,
  status                       public.notification_status NOT NULL DEFAULT 'queued',
  sent_at                      timestamptz NULL,
  delivered_at                 timestamptz NULL,
  first_opened_at              timestamptz NULL,
  open_count                   integer     NOT NULL DEFAULT 0,
  last_opened_at               timestamptz NULL,
  clicked_at                   timestamptz NULL,
  signed_at                    timestamptz NULL,
  document_acknowledgement_id  uuid        NULL,
  bounce_kind                  text        NULL,
  failure_detail               text        NULL,
  provider_message_id          text        NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid        NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid        NULL,
  CONSTRAINT pk_communication_recipients PRIMARY KEY (id),
  CONSTRAINT fk_communication_recipients__communication_id
    FOREIGN KEY (communication_id) REFERENCES public.communications(id) ON DELETE CASCADE,
  CONSTRAINT fk_communication_recipients__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_recipients__document_acknowledgement_id
    FOREIGN KEY (document_acknowledgement_id) REFERENCES public.document_acknowledgements(id) ON DELETE SET NULL,
  CONSTRAINT fk_communication_recipients__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_communication_recipients__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_communication_recipients__email CHECK (
    email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  CONSTRAINT ck_communication_recipients__mobile CHECK (
    mobile IS NULL OR mobile ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT ck_communication_recipients__open_count CHECK (open_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cr__communication_employee
  ON public.communication_recipients (communication_id, employee_id)
  WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cr__slug
  ON public.communication_recipients (slug);
CREATE INDEX IF NOT EXISTS idx_cr__status ON public.communication_recipients (status);
CREATE INDEX IF NOT EXISTS idx_cr__employee_id ON public.communication_recipients (employee_id);
CREATE INDEX IF NOT EXISTS idx_cr__document_acknowledgement_id
  ON public.communication_recipients (document_acknowledgement_id);

DROP TRIGGER IF EXISTS trg_communication_recipients__stamp ON public.communication_recipients;
CREATE TRIGGER trg_communication_recipients__stamp
  BEFORE INSERT ON public.communication_recipients
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_communication_recipients__touch ON public.communication_recipients;
CREATE TRIGGER trg_communication_recipients__touch
  BEFORE UPDATE ON public.communication_recipients
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

-- Tokenised public read/sign links: hash at rest, service-role only (doc:
-- token_hash "(in secure)").
CREATE TABLE IF NOT EXISTS secure.communication_recipient_tokens (
  recipient_id  uuid        NOT NULL,
  token_hash    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NULL,
  revoked_at    timestamptz NULL,
  CONSTRAINT pk_communication_recipient_tokens PRIMARY KEY (recipient_id),
  CONSTRAINT fk_communication_recipient_tokens__recipient_id
    FOREIGN KEY (recipient_id) REFERENCES public.communication_recipients(id) ON DELETE CASCADE,
  CONSTRAINT ck_communication_recipient_tokens__hash CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_recipient_tokens__token_hash
  ON secure.communication_recipient_tokens (token_hash);

ALTER TABLE secure.communication_recipient_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE secure.communication_recipient_tokens FROM PUBLIC, anon, authenticated;

ALTER TABLE public.communication_recipients ENABLE ROW LEVEL SECURITY;

-- P1 self read; P8 admin all.
DROP POLICY IF EXISTS communication_recipients__self__select ON public.communication_recipients;
CREATE POLICY communication_recipients__self__select ON public.communication_recipients
  FOR SELECT TO authenticated
  USING (employee_id IS NOT NULL AND employee_id = app.current_employee_id());

DROP POLICY IF EXISTS communication_recipients__admin__all ON public.communication_recipients;
CREATE POLICY communication_recipients__admin__all ON public.communication_recipients
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.communication_recipients TO authenticated;
REVOKE DELETE ON public.communication_recipients FROM authenticated;

-- -----------------------------------------------------------------------------
-- 5. communication_events — append-only provider webhook trail
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.communication_events (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  communication_id   uuid        NOT NULL,
  recipient_id       uuid        NULL,
  event              text        NOT NULL,
  provider           text        NULL,
  provider_event_id  text        NULL,
  payload            jsonb       NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid        NULL,
  CONSTRAINT pk_communication_events PRIMARY KEY (id),
  CONSTRAINT fk_communication_events__communication_id
    FOREIGN KEY (communication_id) REFERENCES public.communications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_events__recipient_id
    FOREIGN KEY (recipient_id) REFERENCES public.communication_recipients(id) ON DELETE RESTRICT,
  CONSTRAINT ck_communication_events__event CHECK (event IN
    ('queued','sent','delivered','deferred','bounced','complained','opened',
     'clicked','unsubscribed','signed')),
  CONSTRAINT ck_communication_events__provider CHECK (provider IS NULL OR provider IN
    ('resend','supabase_smtp','msg91'))
);

CREATE INDEX IF NOT EXISTS idx_communication_events__communication_time
  ON public.communication_events (communication_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_communication_events__recipient_id
  ON public.communication_events (recipient_id);
CREATE INDEX IF NOT EXISTS idx_communication_events__occurred_at_brin
  ON public.communication_events USING brin (occurred_at);

DROP TRIGGER IF EXISTS trg_communication_events__immutable ON public.communication_events;
CREATE TRIGGER trg_communication_events__immutable
  BEFORE UPDATE OR DELETE ON public.communication_events
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.communication_events ENABLE ROW LEVEL SECURITY;

-- Admin read only; EF (service role) writes.
DROP POLICY IF EXISTS communication_events__admin__select ON public.communication_events;
CREATE POLICY communication_events__admin__select ON public.communication_events
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT ON public.communication_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.communication_events FROM authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON public.communication_events TO service_role;
    REVOKE UPDATE, DELETE ON public.communication_events FROM service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. notifications — partitioned RANGE (recorded_at), quarterly (§12.4)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notifications (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  employee_id          uuid        NULL,
  profile_id           uuid        NULL,
  template_id          uuid        NULL,
  event_code           text        NOT NULL,
  channel              public.notification_channel NOT NULL DEFAULT 'in_app',
  title                text        NOT NULL,
  body                 text        NULL,
  deep_link            text        NULL,
  payload              jsonb       NULL,
  priority             text        NOT NULL DEFAULT 'normal',
  status               public.notification_status NOT NULL DEFAULT 'queued',
  scheduled_for        timestamptz NULL,
  sent_at              timestamptz NULL,
  delivered_at         timestamptz NULL,
  read_at              timestamptz NULL,
  dismissed_at         timestamptz NULL,
  action_taken_at      timestamptz NULL,
  provider_message_id  text        NULL,
  failure_detail       text        NULL,
  retry_count          integer     NOT NULL DEFAULT 0,
  dedupe_key           text        NULL,
  expires_at           timestamptz NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_notifications PRIMARY KEY (id, recorded_at),
  CONSTRAINT fk_notifications__employee_id
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications__profile_id
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications__template_id
    FOREIGN KEY (template_id) REFERENCES public.notification_templates(id) ON DELETE SET NULL,
  CONSTRAINT ck_notifications__priority CHECK (priority IN
    ('low','normal','high','critical')),
  CONSTRAINT ck_notifications__retry_count CHECK (retry_count >= 0),
  CONSTRAINT ck_notifications__recipient CHECK (
    employee_id IS NOT NULL OR profile_id IS NOT NULL)
) PARTITION BY RANGE (recorded_at);

COMMENT ON TABLE public.notifications IS
  'Per-user notification feed. Partitioned quarterly on recorded_at (UTC boundaries, §12.4); read rows purged at 12 months. The dedupe unique index is per partition: a partitioned unique index would have to include recorded_at, which defeats dedupe.';

-- Quarterly partitions: current quarter -> +5 (same pattern as the 006
-- data_access_log). RLS enabled on each; only the parent is exposed via
-- PostgREST.
DO $$
DECLARE
  v_q    date := date_trunc('quarter', now())::date;
  v_name text;
  i      integer;
BEGIN
  FOR i IN 0..5 LOOP
    v_name := 'notifications_' || to_char(v_q, 'YYYY') || '_q' || to_char(v_q, 'Q');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.notifications FOR VALUES FROM (%L) TO (%L)',
        v_name, v_q, (v_q + interval '3 months')::date);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    END IF;
    -- uq_notifications__dedupe, per partition (see table comment).
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (dedupe_key) WHERE dedupe_key IS NOT NULL',
      'uq_' || v_name || '__dedupe', v_name);
    v_q := (v_q + interval '3 months')::date;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications__profile_unread
  ON public.notifications (profile_id, recorded_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications__scheduled
  ON public.notifications (scheduled_for) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_notifications__employee_id
  ON public.notifications (employee_id);
CREATE INDEX IF NOT EXISTS idx_notifications__template_id
  ON public.notifications (template_id);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- P1: self read; self update limited to read_at/dismissed_at by COLUMN GRANT.
DROP POLICY IF EXISTS notifications__self__select ON public.notifications;
CREATE POLICY notifications__self__select ON public.notifications
  FOR SELECT TO authenticated
  USING (
    (profile_id IS NOT NULL AND profile_id = app.ctx_actor_id())
    OR (employee_id IS NOT NULL AND employee_id = app.current_employee_id()));

DROP POLICY IF EXISTS notifications__self__update ON public.notifications;
CREATE POLICY notifications__self__update ON public.notifications
  FOR UPDATE TO authenticated
  USING (
    (profile_id IS NOT NULL AND profile_id = app.ctx_actor_id())
    OR (employee_id IS NOT NULL AND employee_id = app.current_employee_id()))
  WITH CHECK (
    (profile_id IS NOT NULL AND profile_id = app.ctx_actor_id())
    OR (employee_id IS NOT NULL AND employee_id = app.current_employee_id()));

-- P8: admin read (governance); writes are service-role only.
DROP POLICY IF EXISTS notifications__admin__select ON public.notifications;
CREATE POLICY notifications__admin__select ON public.notifications
  FOR SELECT TO authenticated
  USING (app.is_admin());

GRANT SELECT ON public.notifications TO authenticated;
REVOKE INSERT, DELETE ON public.notifications FROM authenticated;
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT UPDATE (read_at, dismissed_at) ON public.notifications TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.notifications TO service_role;
    REVOKE DELETE ON public.notifications FROM service_role;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. notification_preferences
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  profile_id         uuid        NOT NULL,
  event_code         text        NOT NULL,
  channel            public.notification_channel NOT NULL,
  is_enabled         boolean     NOT NULL DEFAULT true,
  quiet_hours_start  time        NULL,
  quiet_hours_end    time        NULL,
  digest_frequency   text        NOT NULL DEFAULT 'immediate',
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NULL,
  CONSTRAINT pk_notification_preferences PRIMARY KEY (id),
  CONSTRAINT fk_notification_preferences__profile_id
    FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_preferences__created_by
    FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_preferences__updated_by
    FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_notification_preferences__digest CHECK (digest_frequency IN
    ('immediate','hourly','daily','weekly','off')),
  CONSTRAINT ck_notification_preferences__quiet_hours CHECK (
    (quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))
);

COMMENT ON TABLE public.notification_preferences IS
  'Transactional/statutory notifications (notification_templates.is_transactional) ignore preferences — no opt-out from "salary credited" or a safety alert. Quiet hours respected for everything else; half the staff finish at 01:30.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_np__profile_event_channel
  ON public.notification_preferences (profile_id, event_code, channel);

DROP TRIGGER IF EXISTS trg_notification_preferences__stamp ON public.notification_preferences;
CREATE TRIGGER trg_notification_preferences__stamp
  BEFORE INSERT ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_notification_preferences__touch ON public.notification_preferences;
CREATE TRIGGER trg_notification_preferences__touch
  BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- P1 self S,I,U; P8 admin.
DROP POLICY IF EXISTS notification_preferences__self__select ON public.notification_preferences;
CREATE POLICY notification_preferences__self__select ON public.notification_preferences
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS notification_preferences__self__insert ON public.notification_preferences;
CREATE POLICY notification_preferences__self__insert ON public.notification_preferences
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS notification_preferences__self__update ON public.notification_preferences;
CREATE POLICY notification_preferences__self__update ON public.notification_preferences
  FOR UPDATE TO authenticated
  USING (profile_id = app.ctx_actor_id())
  WITH CHECK (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS notification_preferences__admin__all ON public.notification_preferences;
CREATE POLICY notification_preferences__admin__all ON public.notification_preferences
  FOR ALL TO authenticated
  USING (app.is_admin()) WITH CHECK (app.is_admin());

GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
REVOKE DELETE ON public.notification_preferences FROM authenticated;

COMMIT;
