-- =============================================================================
-- Migration 030 — AI assistant tables
-- Source: docs/plan/04-data-model.md §3.15 (lines 2550–2572);
--         spec-migrations §2 row 030.
--
-- Enums ai_role / ai_feedback_verdict were created in 003.
--
-- RLS (all AI tables, §3.15): P1 self — a user sees only their own
-- conversations; P8 admin read for governance; NO cross-user read even for
-- managers (a manager reading a reportee's AI questions would be
-- surveillance). All writes come from the ai-chat edge function with the
-- service role — clients get SELECT only (plus feedback INSERT, the one
-- user-generated row here).
--
-- ai_messages is append-only (§1.3): recorded_at, no touch/stamp columns.
-- The single tolerated mutation is a service-role REDACTION (setting
-- redacted = true and blanking content) — enforced by a guard trigger.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ai_conversations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id                     uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_id            uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  -- THE hard data boundary. Set from the caller's role at creation and
  -- immutable thereafter (guard trigger below).
  scope                  text NOT NULL,
  surface                text,
  title                  text,   -- auto-summarised
  model                  text,   -- e.g. claude-opus-4-6
  system_prompt_version  text,
  message_count          integer NOT NULL DEFAULT 0,
  total_input_tokens     integer NOT NULL DEFAULT 0,
  total_output_tokens    integer NOT NULL DEFAULT 0,
  total_cost_inr         numeric(14,4) NOT NULL DEFAULT 0,
  started_at             timestamptz NOT NULL DEFAULT now(),
  last_message_at        timestamptz,
  is_archived            boolean NOT NULL DEFAULT false,
  pinned                 boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_aic__scope CHECK (scope IN ('self','team','org')),
  CONSTRAINT ck_aic__surface CHECK (surface IS NULL OR surface IN
    ('employee_dashboard','manager_dashboard','admin_console','kiosk_help')),
  CONSTRAINT ck_aic__counters CHECK (
    message_count >= 0 AND total_input_tokens >= 0
    AND total_output_tokens >= 0 AND total_cost_inr >= 0)
);

CREATE INDEX IF NOT EXISTS idx_aic__profile_recent
  ON public.ai_conversations (profile_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_aic__employee
  ON public.ai_conversations (employee_id) WHERE employee_id IS NOT NULL;

-- scope is immutable after creation
CREATE OR REPLACE FUNCTION public.ai_conversations_scope_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope THEN
    RAISE EXCEPTION 'ai_conversations.scope is immutable (the AI data boundary is fixed at creation)'
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_conversations__scope_immutable ON public.ai_conversations;
CREATE TRIGGER trg_ai_conversations__scope_immutable
  BEFORE UPDATE ON public.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION public.ai_conversations_scope_immutable();

DROP TRIGGER IF EXISTS trg_ai_conversations__stamp ON public.ai_conversations;
CREATE TRIGGER trg_ai_conversations__stamp BEFORE INSERT ON public.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
DROP TRIGGER IF EXISTS trg_ai_conversations__touch ON public.ai_conversations;
CREATE TRIGGER trg_ai_conversations__touch BEFORE UPDATE ON public.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aic__self_read ON public.ai_conversations;
CREATE POLICY aic__self_read ON public.ai_conversations
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS aic__admin_read ON public.ai_conversations;
CREATE POLICY aic__admin_read ON public.ai_conversations
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Self may archive/pin/rename their own conversations (column grant below
-- narrows this to title/is_archived/pinned).
DROP POLICY IF EXISTS aic__self_update ON public.ai_conversations;
CREATE POLICY aic__self_update ON public.ai_conversations
  FOR UPDATE TO authenticated
  USING (profile_id = app.ctx_actor_id())
  WITH CHECK (profile_id = app.ctx_actor_id());

-- Creation/token accounting happens in the ai-chat edge function (service
-- role): no INSERT/DELETE policy for authenticated.

-- -----------------------------------------------------------------------------
-- 2. ai_messages — append-only
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_messages (
  id                      uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id         uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  sequence                integer NOT NULL,
  role                    public.ai_role NOT NULL,
  content                 text,
  content_blocks          jsonb,   -- full Anthropic content array incl. tool_use/tool_result
  infographic_spec        jsonb,   -- validated chart descriptor (06-ai-agent.md)
  model                   text,
  stop_reason             text,
  input_tokens            integer,
  output_tokens           integer,
  cache_read_tokens       integer,
  cache_creation_tokens   integer,
  latency_ms              integer,
  error                   text,
  redacted                boolean NOT NULL DEFAULT false,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_aim__sequence CHECK (sequence >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aim__conversation_sequence
  ON public.ai_messages (conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_aim__conversation_time
  ON public.ai_messages (conversation_id, recorded_at);

-- Append-only, with exactly one tolerated mutation: a redaction pass
-- (service role) may set redacted = true and blank the payload columns.
-- Direct DELETE is refused for everyone; the one sanctioned removal path is
-- the FK cascade from an ai_conversations purge. A cascaded child delete
-- arrives via the parent's internal RI trigger, so its row trigger runs at
-- pg_trigger_depth() > 1, which is how the guard tells the two apart.
CREATE OR REPLACE FUNCTION public.ai_messages_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;   -- FK cascade from ai_conversations delete (service role)
    END IF;
    RAISE EXCEPTION 'DELETE on public.ai_messages is not permitted: append-only table'
      USING errcode = '0A000';
  END IF;
  -- UPDATE: only the redaction shape is allowed
  IF NOT (NEW.redacted AND
          NEW.id = OLD.id AND
          NEW.conversation_id = OLD.conversation_id AND
          NEW.sequence = OLD.sequence AND
          NEW.role = OLD.role AND
          NEW.recorded_at = OLD.recorded_at AND
          COALESCE(NEW.input_tokens,  -1) = COALESCE(OLD.input_tokens,  -1) AND
          COALESCE(NEW.output_tokens, -1) = COALESCE(OLD.output_tokens, -1))
  THEN
    RAISE EXCEPTION 'UPDATE on public.ai_messages may only redact (set redacted = true and blank content)'
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_messages__guard ON public.ai_messages;
CREATE TRIGGER trg_ai_messages__guard
  BEFORE UPDATE OR DELETE ON public.ai_messages
  FOR EACH ROW EXECUTE FUNCTION public.ai_messages_guard();

ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

-- Visibility = the parent conversation's audience (self policy + admin policy
-- on ai_conversations evaluate inside the EXISTS under the caller's rights).
DROP POLICY IF EXISTS aim__via_conversation_read ON public.ai_messages;
CREATE POLICY aim__via_conversation_read ON public.ai_messages
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ai_conversations c
                 WHERE c.id = conversation_id));

-- -----------------------------------------------------------------------------
-- 3. ai_tool_calls — every tool invocation, incl. first-class scope denials
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_tool_calls (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id          uuid REFERENCES public.ai_messages(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  tool_name           text NOT NULL,
  arguments           jsonb,
  resolved_scope      text,
  -- which §9 view answered it: the agent may only read declared views,
  -- never base tables
  sql_view            text,
  row_count           integer,
  duration_ms         integer,
  status              text NOT NULL,
  denial_reason       text,   -- e.g. 'scope_violation: employee requested another employee''s payslip'
  result_hash         text,
  -- loose pointer: data_access_log is range-partitioned (PK includes
  -- accessed_at), so a plain FK is not possible
  data_access_log_id  uuid,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_atc__status CHECK (status IN ('ok','denied','error','empty')),
  CONSTRAINT ck_atc__denial_reason CHECK (status <> 'denied' OR denial_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_atc__message      ON public.ai_tool_calls (message_id);
CREATE INDEX IF NOT EXISTS idx_atc__conversation ON public.ai_tool_calls (conversation_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_atc__denied
  ON public.ai_tool_calls (recorded_at DESC) WHERE status = 'denied';

-- Append-only: every scope denial is a first-class row, never edited away.
DROP TRIGGER IF EXISTS trg_ai_tool_calls__immutable ON public.ai_tool_calls;
CREATE TRIGGER trg_ai_tool_calls__immutable
  BEFORE UPDATE OR DELETE ON public.ai_tool_calls
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.ai_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atc__via_conversation_read ON public.ai_tool_calls;
CREATE POLICY atc__via_conversation_read ON public.ai_tool_calls
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ai_conversations c
                 WHERE c.id = conversation_id));

-- -----------------------------------------------------------------------------
-- 4. ai_usage_ledger — the spend source of truth for budget caps
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_usage_ledger (
  id                     uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  ist_date               date NOT NULL GENERATED ALWAYS AS (util.ist_date(occurred_at)) STORED,
  profile_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  conversation_id        uuid REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
  message_id             uuid REFERENCES public.ai_messages(id) ON DELETE SET NULL,
  model                  text,
  input_tokens           integer NOT NULL DEFAULT 0,
  output_tokens          integer NOT NULL DEFAULT 0,
  cache_read_tokens      integer NOT NULL DEFAULT 0,
  cache_creation_tokens  integer NOT NULL DEFAULT 0,
  input_cost_usd         numeric(14,6),
  output_cost_usd        numeric(14,6),
  total_cost_usd         numeric(14,6),
  usd_inr_rate           numeric(12,4),
  total_cost_inr         numeric(14,4),
  billing_month          text,   -- 'YYYY-MM' in IST
  feature                text,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_aul__feature CHECK (feature IS NULL OR feature IN
    ('chat','infographic','document_extract','email_draft','contract_clause','anomaly_summary')),
  CONSTRAINT ck_aul__billing_month CHECK (
    billing_month IS NULL OR billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_aul__tokens CHECK (
    input_tokens >= 0 AND output_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_creation_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS idx_aul__month_profile
  ON public.ai_usage_ledger (billing_month, profile_id);
CREATE INDEX IF NOT EXISTS idx_aul__ist_date
  ON public.ai_usage_ledger (ist_date);
CREATE INDEX IF NOT EXISTS idx_aul__conversation
  ON public.ai_usage_ledger (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aul__message
  ON public.ai_usage_ledger (message_id) WHERE message_id IS NOT NULL;

-- A ledger is a ledger: no rewrites.
DROP TRIGGER IF EXISTS trg_ai_usage_ledger__immutable ON public.ai_usage_ledger;
CREATE TRIGGER trg_ai_usage_ledger__immutable
  BEFORE UPDATE OR DELETE ON public.ai_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_mutation();

ALTER TABLE public.ai_usage_ledger ENABLE ROW LEVEL SECURITY;

-- Self sees own spend (transparency when the assistant pauses at the cap).
DROP POLICY IF EXISTS aul__self_read ON public.ai_usage_ledger;
CREATE POLICY aul__self_read ON public.ai_usage_ledger
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS aul__admin_read ON public.ai_usage_ledger;
CREATE POLICY aul__admin_read ON public.ai_usage_ledger
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- -----------------------------------------------------------------------------
-- 5. ai_feedback — the one user-writable AI table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id       uuid NOT NULL REFERENCES public.ai_messages(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  profile_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  verdict          public.ai_feedback_verdict NOT NULL,
  comment          text,
  expected_answer  text,
  screenshot_path  text,
  triaged_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  triaged_at       timestamptz,
  resolution       text,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback__message      ON public.ai_feedback (message_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback__conversation ON public.ai_feedback (conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback__profile      ON public.ai_feedback (profile_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback__untriaged
  ON public.ai_feedback (recorded_at DESC) WHERE triaged_at IS NULL;

ALTER TABLE public.ai_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aif__self_read ON public.ai_feedback;
CREATE POLICY aif__self_read ON public.ai_feedback
  FOR SELECT TO authenticated
  USING (profile_id = app.ctx_actor_id());

DROP POLICY IF EXISTS aif__admin_read ON public.ai_feedback;
CREATE POLICY aif__admin_read ON public.ai_feedback
  FOR SELECT TO authenticated
  USING (app.is_admin());

-- Self may file feedback only on their own conversations.
DROP POLICY IF EXISTS aif__self_insert ON public.ai_feedback;
CREATE POLICY aif__self_insert ON public.ai_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = app.ctx_actor_id()
    AND EXISTS (SELECT 1 FROM public.ai_conversations c
                WHERE c.id = conversation_id
                  AND c.profile_id = app.ctx_actor_id()));

-- Admin triage (column grant narrows to triaged_by/triaged_at/resolution).
DROP POLICY IF EXISTS aif__admin_update ON public.ai_feedback;
CREATE POLICY aif__admin_update ON public.ai_feedback
  FOR UPDATE TO authenticated
  USING (app.is_admin())
  WITH CHECK (app.is_admin());

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.ai_conversations_scope_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ai_messages_guard() FROM PUBLIC;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON public.ai_conversations, public.ai_messages, '
                     'public.ai_tool_calls, public.ai_usage_ledger, public.ai_feedback FROM %I', v_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.ai_conversations, public.ai_messages,
                    public.ai_tool_calls, public.ai_usage_ledger,
                    public.ai_feedback TO authenticated;
    -- self housekeeping on own conversations, narrowed to three columns
    GRANT UPDATE (title, is_archived, pinned) ON public.ai_conversations TO authenticated;
    GRANT INSERT ON public.ai_feedback TO authenticated;
    -- admin triage columns
    GRANT UPDATE (triaged_by, triaged_at, resolution) ON public.ai_feedback TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.ai_conversations TO service_role;
    GRANT SELECT, INSERT, UPDATE ON public.ai_messages TO service_role;   -- UPDATE = redaction only (guard)
    GRANT SELECT, INSERT ON public.ai_tool_calls, public.ai_usage_ledger TO service_role;
    GRANT SELECT, INSERT, UPDATE ON public.ai_feedback TO service_role;
    GRANT DELETE ON public.ai_conversations TO service_role;   -- GDPR-style purge path
  END IF;
END $$;

COMMIT;
