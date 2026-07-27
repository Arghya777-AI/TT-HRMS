-- =============================================================================
-- Migration 009 — employee satellite tables
-- Source: docs/plan/04-data-model.md §3.3 (lines 917–1136), §4.7 (sensitive
--         fields), §8.11 (guard triggers); spec-migrations §2 row 009.
--
-- Ten satellites: addresses, contacts, dependents, qualifications,
-- identity documents, statutory (1:1), bank accounts, swipe cards, skills,
-- hobbies — plus the satellite half of profile completeness.
--
-- Sensitive columns (aadhaar_number, pan, uan, pf_number, esi_number,
-- account_number, document_number) carry NO SELECT grant for authenticated;
-- non-privileged reads see only *_last4. Unmasked access arrives with the
-- rpc.reveal_* functions (032), which log to data_access_log first.
--
-- Forward FKs to public.documents (025) are handled by the deferred sweep.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. employee_addresses (P3: self + admin; managers deliberately excluded)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_addresses (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  address_kind  text NOT NULL,
  line1         text NOT NULL,
  line2         text,
  landmark      text,
  city          text NOT NULL,
  district      text,
  state         text NOT NULL,
  pincode       text NOT NULL,
  country       text NOT NULL DEFAULT 'India',
  is_current    boolean NOT NULL DEFAULT true,
  valid_from    date,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ea__kind    CHECK (address_kind IN ('permanent','correspondence','emergency','previous')),
  CONSTRAINT ck_ea__pincode CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT ck_ea__range   CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_addresses__kind_current
  ON public.employee_addresses (employee_id, address_kind) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_employee_addresses__employee ON public.employee_addresses (employee_id);

CREATE TRIGGER trg_employee_addresses__stamp BEFORE INSERT ON public.employee_addresses
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_addresses__touch BEFORE UPDATE ON public.employee_addresses
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_addresses__self_all ON public.employee_addresses;
CREATE POLICY employee_addresses__self_all ON public.employee_addresses
  FOR ALL TO authenticated
  USING (employee_id = app.current_employee_id())
  WITH CHECK (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS employee_addresses__admin_all ON public.employee_addresses;
CREATE POLICY employee_addresses__admin_all ON public.employee_addresses
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 2. employee_contacts (P3; emergency readable by manager/guard via edge fn ONLY)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_contacts (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  contact_kind  text NOT NULL,
  value         text NOT NULL,
  contact_name  text,
  relationship  text,
  is_primary    boolean NOT NULL DEFAULT false,
  is_verified   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ec__kind CHECK (contact_kind IN
    ('mobile','alternate_mobile','residence','office','office_extension','emergency','whatsapp')),
  CONSTRAINT ck_ec__value CHECK (
    CASE contact_kind
      WHEN 'mobile'           THEN value ~ '^[6-9][0-9]{9}$'
      WHEN 'alternate_mobile' THEN value ~ '^[6-9][0-9]{9}$'
      WHEN 'whatsapp'         THEN value ~ '^[6-9][0-9]{9}$'
      WHEN 'emergency'        THEN value ~ '^[0-9]{6,14}$'
      WHEN 'residence'        THEN value ~ '^[0-9]{6,14}$'
      WHEN 'office'           THEN value ~ '^[0-9]{6,14}$'
      WHEN 'office_extension' THEN value ~ '^[0-9]{1,6}$'
    END),
  CONSTRAINT ck_ec__emergency_fields CHECK (
    contact_kind <> 'emergency' OR (contact_name IS NOT NULL AND relationship IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_contacts__primary
  ON public.employee_contacts (employee_id, contact_kind) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_employee_contacts__employee ON public.employee_contacts (employee_id);

CREATE TRIGGER trg_employee_contacts__stamp BEFORE INSERT ON public.employee_contacts
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_contacts__touch BEFORE UPDATE ON public.employee_contacts
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_contacts__self_all ON public.employee_contacts;
CREATE POLICY employee_contacts__self_all ON public.employee_contacts
  FOR ALL TO authenticated
  USING (employee_id = app.current_employee_id())
  WITH CHECK (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS employee_contacts__admin_all ON public.employee_contacts;
CREATE POLICY employee_contacts__admin_all ON public.employee_contacts
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 3. employee_dependents (P3; nominee shares must total 100 per scheme)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_dependents (
  id                         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id                uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  full_name                  text NOT NULL,
  relationship               text NOT NULL,
  date_of_birth              date,
  gender                     public.gender,
  is_nominee                 boolean NOT NULL DEFAULT false,
  nominee_share_pct          numeric(6,3),
  nominee_scheme             text,
  is_dependent_for_insurance boolean NOT NULL DEFAULT false,
  aadhaar_last4              text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_ed__relationship CHECK (relationship IN
    ('spouse','son','daughter','father','mother','father_in_law','mother_in_law','brother','sister','other')),
  CONSTRAINT ck_ed__scheme CHECK (nominee_scheme IS NULL OR nominee_scheme IN
    ('pf','gratuity','esi','group_insurance')),
  CONSTRAINT ck_ed__share CHECK (nominee_share_pct IS NULL OR (nominee_share_pct > 0 AND nominee_share_pct <= 100)),
  CONSTRAINT ck_ed__nominee_fields CHECK (NOT is_nominee OR (nominee_scheme IS NOT NULL AND nominee_share_pct IS NOT NULL)),
  CONSTRAINT ck_ed__aadhaar_last4 CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$')
);

CREATE INDEX IF NOT EXISTS idx_employee_dependents__employee ON public.employee_dependents (employee_id);

-- Deferred: active nominee shares per (employee_id, scheme) total exactly 100.
CREATE OR REPLACE FUNCTION public.employee_dependents_share_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_employee uuid := COALESCE(NEW.employee_id, OLD.employee_id);
  bad record;
BEGIN
  FOR bad IN
    SELECT d.nominee_scheme, sum(d.nominee_share_pct) AS total
    FROM public.employee_dependents d
    WHERE d.employee_id = v_employee AND d.is_nominee
    GROUP BY d.nominee_scheme
    HAVING sum(d.nominee_share_pct) <> 100
  LOOP
    RAISE EXCEPTION 'nominee shares for scheme % total % — must be exactly 100',
      bad.nominee_scheme, bad.total USING errcode = '23514';
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_employee_dependents__nominee_shares
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_dependents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.employee_dependents_share_check();

CREATE TRIGGER trg_employee_dependents__stamp BEFORE INSERT ON public.employee_dependents
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_dependents__touch BEFORE UPDATE ON public.employee_dependents
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_dependents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_dependents__self_all ON public.employee_dependents;
CREATE POLICY employee_dependents__self_all ON public.employee_dependents
  FOR ALL TO authenticated
  USING (employee_id = app.current_employee_id())
  WITH CHECK (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS employee_dependents__admin_all ON public.employee_dependents;
CREATE POLICY employee_dependents__admin_all ON public.employee_dependents
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 4. employee_qualifications (P4; licence expiries feed the reminder job)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_qualifications (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  qualification_kind  text NOT NULL,
  degree_or_course    text,
  specialisation      text,
  institution         text,
  board_or_university text,
  mode                text,
  start_year          integer,
  end_year            integer,
  grade_or_percentage text,
  certificate_number  text,
  is_highest          boolean NOT NULL DEFAULT false,
  document_id         uuid,   -- FK added by deferred sweep (documents in 025)
  verified_at         timestamptz,
  verified_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  licence_kind        text,
  licence_number      text,
  licence_expiry      date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_eq__kind CHECK (qualification_kind IN
    ('school','diploma','graduate','post_graduate','doctorate','certification','licence')),
  CONSTRAINT ck_eq__mode CHECK (mode IS NULL OR mode IN ('full_time','part_time','distance')),
  CONSTRAINT ck_eq__licence_kind CHECK (licence_kind IS NULL OR licence_kind IN
    ('food_safety','fssai_supervisor','first_aid','fire_safety','bartending','driving')),
  CONSTRAINT ck_eq__years CHECK (
    (start_year IS NULL OR start_year BETWEEN 1950 AND 2099)
    AND (end_year IS NULL OR end_year BETWEEN 1950 AND 2099)),
  CONSTRAINT ck_eq__licence_expiry CHECK (licence_expiry IS NULL OR licence_expiry < DATE '2100-01-01')
);

CREATE INDEX IF NOT EXISTS idx_employee_qualifications__employee ON public.employee_qualifications (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_qualifications__licence_expiry
  ON public.employee_qualifications (licence_expiry) WHERE licence_expiry IS NOT NULL;

CREATE TRIGGER trg_employee_qualifications__stamp BEFORE INSERT ON public.employee_qualifications
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_qualifications__touch BEFORE UPDATE ON public.employee_qualifications
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_qualifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_qualifications__scope_read ON public.employee_qualifications;
CREATE POLICY employee_qualifications__scope_read ON public.employee_qualifications
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

-- Self may add; edits to verified rows are maker-checker (change request).
DROP POLICY IF EXISTS employee_qualifications__self_insert ON public.employee_qualifications;
CREATE POLICY employee_qualifications__self_insert ON public.employee_qualifications
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS employee_qualifications__self_update_unverified ON public.employee_qualifications;
CREATE POLICY employee_qualifications__self_update_unverified ON public.employee_qualifications
  FOR UPDATE TO authenticated
  USING (employee_id = app.current_employee_id() AND verified_at IS NULL)
  WITH CHECK (employee_id = app.current_employee_id() AND verified_at IS NULL);

DROP POLICY IF EXISTS employee_qualifications__admin_all ON public.employee_qualifications;
CREATE POLICY employee_qualifications__admin_all ON public.employee_qualifications
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 5. employee_identity_documents (P6 sensitive)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_identity_documents (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  document_kind     public.id_document_kind NOT NULL,
  document_number   text NOT NULL,
  number_last4      text NOT NULL GENERATED ALWAYS AS (right(document_number, 4)) STORED,
  name_on_document  text,
  issue_date        date,
  expiry_date       date,
  issuing_country   text NOT NULL DEFAULT 'India',
  issuing_authority text,
  place_of_issue    text,
  visa_kind         text,
  visa_valid_from   date,
  visa_valid_to     date,
  document_id       uuid,   -- FK added by deferred sweep (documents in 025)
  is_verified       boolean NOT NULL DEFAULT false,
  verified_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at       timestamptz,
  is_current        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_eid__visa_kind CHECK (visa_kind IS NULL OR visa_kind IN ('employment','business','tourist')),
  CONSTRAINT ck_eid__expiry CHECK (expiry_date IS NULL OR expiry_date < DATE '2100-01-01')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eid__kind_current
  ON public.employee_identity_documents (employee_id, document_kind) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_eid__expiry
  ON public.employee_identity_documents (expiry_date) WHERE expiry_date IS NOT NULL AND is_current;
CREATE INDEX IF NOT EXISTS idx_eid__employee ON public.employee_identity_documents (employee_id);

-- Kind-specific number validation (§3.3 trg_eid__validate).
CREATE OR REPLACE FUNCTION public.eid_validate()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT (
    CASE NEW.document_kind
      WHEN 'aadhaar'         THEN util.is_valid_aadhaar(NEW.document_number)
      WHEN 'pan'             THEN NEW.document_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
      WHEN 'passport'        THEN NEW.document_number ~ '^[A-Z][0-9]{7}$'
      WHEN 'voter_id'        THEN NEW.document_number ~ '^[A-Z]{3}[0-9]{7}$'
      WHEN 'driving_licence' THEN NEW.document_number ~ '^[A-Z0-9/ -]{8,20}$'
      ELSE length(btrim(NEW.document_number)) >= 3
    END
  ) THEN
    RAISE EXCEPTION 'invalid % number (fails format/checksum validation)', NEW.document_kind
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_eid__validate
  BEFORE INSERT OR UPDATE OF document_number, document_kind ON public.employee_identity_documents
  FOR EACH ROW EXECUTE FUNCTION public.eid_validate();

CREATE TRIGGER trg_eid__stamp BEFORE INSERT ON public.employee_identity_documents
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_eid__touch BEFORE UPDATE ON public.employee_identity_documents
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_identity_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eid__self_read ON public.employee_identity_documents;
CREATE POLICY eid__self_read ON public.employee_identity_documents
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS eid__admin_all ON public.employee_identity_documents;
CREATE POLICY eid__admin_all ON public.employee_identity_documents
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 6. employee_statutory (1:1, P6 sensitive)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_statutory (
  employee_id                 uuid NOT NULL PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  pf_applicable               boolean NOT NULL DEFAULT true,
  pf_number                   text,
  uan                         text,
  pf_joining_date             date,
  pf_wage_ceiling_applied     boolean NOT NULL DEFAULT true,
  eps_applicable              boolean NOT NULL DEFAULT true,
  esi_applicable              boolean NOT NULL DEFAULT false,
  esi_number                  text,
  esi_dispensary              text,
  pan                         text,
  aadhaar_number              text,
  aadhaar_last4               text GENERATED ALWAYS AS (right(aadhaar_number, 4)) STORED,
  aadhaar_linked_to_uan       boolean NOT NULL DEFAULT false,
  professional_tax_applicable boolean NOT NULL DEFAULT true,
  professional_tax_state      text NOT NULL DEFAULT 'Karnataka',
  lwf_applicable              boolean NOT NULL DEFAULT true,
  gratuity_eligible_from      date,
  tax_regime                  text NOT NULL DEFAULT 'new',
  tax_regime_locked_fy        text,
  is_director_or_partner      boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_es__pan     CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT ck_es__aadhaar CHECK (aadhaar_number IS NULL OR util.is_valid_aadhaar(aadhaar_number)),
  CONSTRAINT ck_es__uan     CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  CONSTRAINT ck_es__esi     CHECK (esi_number IS NULL OR esi_number ~ '^[0-9]{17}$'),
  CONSTRAINT ck_es__pf      CHECK (pf_number IS NULL OR pf_number ~ '^[A-Z]{2}/[A-Z]{3}/[0-9]{7}/[0-9]{3}/[0-9]{7}$' OR pf_number ~ '^[A-Z0-9/]{10,30}$'),
  CONSTRAINT ck_es__regime  CHECK (tax_regime IN ('old','new'))
);

CREATE TRIGGER trg_employee_statutory__stamp BEFORE INSERT ON public.employee_statutory
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_statutory__touch BEFORE UPDATE ON public.employee_statutory
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_statutory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_statutory__self_read ON public.employee_statutory;
CREATE POLICY employee_statutory__self_read ON public.employee_statutory
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS employee_statutory__admin_all ON public.employee_statutory;
CREATE POLICY employee_statutory__admin_all ON public.employee_statutory
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 7. employee_bank_accounts (P6 sensitive; payroll-diversion controls)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_bank_accounts (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id          uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  beneficiary_name     text NOT NULL,
  bank_name            text NOT NULL,
  branch               text,
  ifsc                 text NOT NULL,
  account_number       text NOT NULL,
  account_number_last4 text NOT NULL GENERATED ALWAYS AS (right(account_number, 4)) STORED,
  account_type         text NOT NULL DEFAULT 'savings',
  upi_id               text,
  is_verified          boolean NOT NULL DEFAULT false,
  verification_method  text,
  verified_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at          timestamptz,
  is_active            boolean NOT NULL DEFAULT true,
  effective_from       date NOT NULL DEFAULT CURRENT_DATE,
  effective_to         date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_eba__ifsc    CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  CONSTRAINT ck_eba__account CHECK (account_number ~ '^[0-9]{6,20}$'),
  CONSTRAINT ck_eba__type    CHECK (account_type IN ('savings','current','salary')),
  CONSTRAINT ck_eba__method  CHECK (verification_method IS NULL OR verification_method IN
    ('penny_drop','cancelled_cheque','passbook')),
  CONSTRAINT ck_eba__range   CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eba__active
  ON public.employee_bank_accounts (employee_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_eba__employee ON public.employee_bank_accounts (employee_id);

CREATE TRIGGER trg_eba__stamp BEFORE INSERT ON public.employee_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_eba__touch BEFORE UPDATE ON public.employee_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_bank_accounts ENABLE ROW LEVEL SECURITY;

-- Self reads (masked columns only, via grants); ALL changes are maker-checker
-- (BANK_CHANGE approval) applied by service role — no self write policy.
DROP POLICY IF EXISTS eba__self_read ON public.employee_bank_accounts;
CREATE POLICY eba__self_read ON public.employee_bank_accounts
  FOR SELECT TO authenticated
  USING (employee_id = app.current_employee_id());

DROP POLICY IF EXISTS eba__admin_all ON public.employee_bank_accounts;
CREATE POLICY eba__admin_all ON public.employee_bank_accounts
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 8. employee_swipe_cards (P4; card id independent of employee_code)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_swipe_cards (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  card_number     text NOT NULL,
  card_technology text,
  issued_on       date NOT NULL DEFAULT CURRENT_DATE,
  valid_from      date NOT NULL DEFAULT CURRENT_DATE,
  valid_to        date,   -- NULL = no expiry; never a year-3000 sentinel
  status          text NOT NULL DEFAULT 'active',
  approved_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  returned_on     date,
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_esc__technology CHECK (card_technology IS NULL OR card_technology IN
    ('mifare','em4100','hid_prox','qr')),
  CONSTRAINT ck_esc__status CHECK (status IN
    ('requested','approved','active','lost','damaged','returned','revoked','reported_lost')),
  CONSTRAINT ck_esc__valid_to CHECK (valid_to IS NULL OR valid_to < DATE '2100-01-01')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_esc__card_number_active
  ON public.employee_swipe_cards (card_number) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_esc__employee ON public.employee_swipe_cards (employee_id);

CREATE TRIGGER trg_esc__stamp BEFORE INSERT ON public.employee_swipe_cards
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_esc__touch BEFORE UPDATE ON public.employee_swipe_cards
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_swipe_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS esc__scope_read ON public.employee_swipe_cards;
CREATE POLICY esc__scope_read ON public.employee_swipe_cards
  FOR SELECT TO authenticated
  USING (app.can_see_employee(employee_id));

DROP POLICY IF EXISTS esc__admin_write ON public.employee_swipe_cards;
CREATE POLICY esc__admin_write ON public.employee_swipe_cards
  FOR ALL TO authenticated
  USING (app.is_admin() AND app.admin_scope_covers(employee_id))
  WITH CHECK (app.is_admin() AND app.admin_scope_covers(employee_id));

-- -----------------------------------------------------------------------------
-- 9. employee_skills / employee_hobbies (P4; org-readable for the directory)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.employee_skills (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id      uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  name             text NOT NULL,
  slug             text NOT NULL DEFAULT '',
  proficiency      text,
  years_experience numeric(4,1),
  is_verified      boolean NOT NULL DEFAULT false,
  endorsed_by      uuid[],
  sort_order       integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT ck_esk__proficiency CHECK (proficiency IS NULL OR proficiency IN
    ('beginner','intermediate','advanced','expert'))
);

CREATE TABLE IF NOT EXISTS public.employee_hobbies (
  id          uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- slug via trigger (util.slugify is STABLE — not legal in a generated column).
CREATE OR REPLACE FUNCTION public.slug_from_name()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.slug := util.slugify(NEW.name);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_employee_skills__slug
  BEFORE INSERT OR UPDATE OF name ON public.employee_skills
  FOR EACH ROW EXECUTE FUNCTION public.slug_from_name();
CREATE TRIGGER trg_employee_hobbies__slug
  BEFORE INSERT OR UPDATE OF name ON public.employee_hobbies
  FOR EACH ROW EXECUTE FUNCTION public.slug_from_name();

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_skills__employee_slug
  ON public.employee_skills (employee_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_hobbies__employee_slug
  ON public.employee_hobbies (employee_id, slug);

CREATE TRIGGER trg_employee_skills__stamp BEFORE INSERT ON public.employee_skills
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_skills__touch BEFORE UPDATE ON public.employee_skills
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();
CREATE TRIGGER trg_employee_hobbies__stamp BEFORE INSERT ON public.employee_hobbies
  FOR EACH ROW EXECUTE FUNCTION util.stamp_row();
CREATE TRIGGER trg_employee_hobbies__touch BEFORE UPDATE ON public.employee_hobbies
  FOR EACH ROW EXECUTE FUNCTION util.touch_row();

ALTER TABLE public.employee_skills  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_hobbies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_skills__org_read ON public.employee_skills;
CREATE POLICY employee_skills__org_read ON public.employee_skills
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS employee_hobbies__org_read ON public.employee_hobbies;
CREATE POLICY employee_hobbies__org_read ON public.employee_hobbies
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS employee_skills__self_write ON public.employee_skills;
CREATE POLICY employee_skills__self_write ON public.employee_skills
  FOR ALL TO authenticated
  USING (employee_id = app.current_employee_id() OR app.is_admin())
  WITH CHECK (employee_id = app.current_employee_id() OR app.is_admin());
DROP POLICY IF EXISTS employee_hobbies__self_write ON public.employee_hobbies;
CREATE POLICY employee_hobbies__self_write ON public.employee_hobbies
  FOR ALL TO authenticated
  USING (employee_id = app.current_employee_id() OR app.is_admin())
  WITH CHECK (employee_id = app.current_employee_id() OR app.is_admin());

-- -----------------------------------------------------------------------------
-- 10. Satellite half of profile completeness (40 points)
-- -----------------------------------------------------------------------------

-- emergency contact 15 · verified active bank 10 · PAN or Aadhaar present 8 ·
-- ≥1 nominee 4 · ≥1 qualification 3  = 40
CREATE OR REPLACE FUNCTION public.satellite_completeness_score(p_employee_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    (CASE WHEN EXISTS (SELECT 1 FROM public.employee_contacts c
                       WHERE c.employee_id = p_employee_id AND c.contact_kind = 'emergency')
          THEN 15 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM public.employee_bank_accounts b
                       WHERE b.employee_id = p_employee_id AND b.is_active AND b.is_verified)
          THEN 10 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM public.employee_statutory s
                       WHERE s.employee_id = p_employee_id
                         AND (s.pan IS NOT NULL OR s.aadhaar_number IS NOT NULL))
          THEN 8 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM public.employee_dependents d
                       WHERE d.employee_id = p_employee_id AND d.is_nominee)
          THEN 4 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM public.employee_qualifications q
                       WHERE q.employee_id = p_employee_id)
          THEN 3 ELSE 0 END);
$$;

-- Recompute the employee's full score after a satellite write. Sets a
-- transaction-local system reason first (employees is reason-required) and
-- restores the caller's reason afterwards so their own audit rows keep it.
CREATE OR REPLACE FUNCTION public.recompute_profile_completeness(p_employee_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_caller_reason text := coalesce(current_setting('app.reason', true), '');
BEGIN
  PERFORM set_config('app.reason', 'system: profile completeness recompute', true);
  -- The BEFORE trigger on employees recomputes the value; the assignment here
  -- just needs to touch the row.
  UPDATE public.employees
     SET profile_completeness_pct = profile_completeness_pct
   WHERE id = p_employee_id;
  PERFORM set_config('app.reason', v_caller_reason, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.satellite_completeness_hook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.recompute_profile_completeness(COALESCE(NEW.employee_id, OLD.employee_id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_employee_contacts__completeness
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_contacts
  FOR EACH ROW EXECUTE FUNCTION public.satellite_completeness_hook();
CREATE TRIGGER trg_eba__completeness
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.satellite_completeness_hook();
CREATE TRIGGER trg_employee_statutory__completeness
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_statutory
  FOR EACH ROW EXECUTE FUNCTION public.satellite_completeness_hook();
CREATE TRIGGER trg_employee_dependents__completeness
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_dependents
  FOR EACH ROW EXECUTE FUNCTION public.satellite_completeness_hook();
CREATE TRIGGER trg_employee_qualifications__completeness
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_qualifications
  FOR EACH ROW EXECUTE FUNCTION public.satellite_completeness_hook();

-- -----------------------------------------------------------------------------
-- 11. Grants (sensitive columns EXCLUDED from authenticated SELECT)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON
      public.employee_addresses, public.employee_contacts, public.employee_dependents,
      public.employee_qualifications, public.employee_swipe_cards,
      public.employee_skills, public.employee_hobbies
      TO authenticated;
    GRANT DELETE ON public.employee_skills, public.employee_hobbies TO authenticated;

    -- P6 tables: column-scoped SELECT (full numbers never selectable);
    -- writes admin-gated by policy, applied through PostgREST/edge paths.
    GRANT SELECT (id, employee_id, document_kind, number_last4, name_on_document,
                  issue_date, expiry_date, issuing_country, issuing_authority,
                  place_of_issue, visa_kind, visa_valid_from, visa_valid_to,
                  document_id, is_verified, verified_by, verified_at, is_current,
                  created_at, updated_at)
      ON public.employee_identity_documents TO authenticated;
    GRANT INSERT, UPDATE ON public.employee_identity_documents TO authenticated;

    GRANT SELECT (employee_id, pf_applicable, pf_joining_date, pf_wage_ceiling_applied,
                  eps_applicable, esi_applicable, esi_dispensary, aadhaar_last4,
                  aadhaar_linked_to_uan, professional_tax_applicable,
                  professional_tax_state, lwf_applicable, gratuity_eligible_from,
                  tax_regime, tax_regime_locked_fy, is_director_or_partner,
                  created_at, updated_at)
      ON public.employee_statutory TO authenticated;
    GRANT INSERT, UPDATE ON public.employee_statutory TO authenticated;

    GRANT SELECT (id, employee_id, beneficiary_name, bank_name, branch, ifsc,
                  account_number_last4, account_type, upi_id, is_verified,
                  verification_method, verified_by, verified_at, is_active,
                  effective_from, effective_to, created_at, updated_at)
      ON public.employee_bank_accounts TO authenticated;
    GRANT INSERT, UPDATE ON public.employee_bank_accounts TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.employee_addresses, public.employee_contacts, public.employee_dependents,
      public.employee_qualifications, public.employee_identity_documents,
      public.employee_statutory, public.employee_bank_accounts,
      public.employee_swipe_cards, public.employee_skills, public.employee_hobbies
      TO service_role;
  END IF;
END $$;

COMMIT;
