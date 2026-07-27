-- =============================================================================
-- Migration 063 — demo content for the HR change-request queue
-- (/admin/people/changes).
--
-- WHY: no migration ever seeded `employee_change_requests`, so the maker-checker
-- console rendered a correct empty state and therefore read as unbuilt. The rows
-- here are the ones the self-service screens produce, written through the same
-- shape (`status` left to `ecr_insert_guard`, decision columns untouched), so
-- approving one exercises the real `decide_change_request` → `apply_change_request`
-- path against real employees.
--
-- SAFETY, matching seeds 047/052/053:
--   * guarded by settings.seed_demo_data — flag false ⇒ complete no-op;
--   * idempotent: each row is skipped when that employee already has a request
--     for the same field in any state;
--   * deterministic: no random(). Values derive from employee_code and the row
--     number, so every rebuild produces the identical queue;
--   * every proposed value satisfies the real column constraint
--     (ck_employees__mobile_in '^[6-9][0-9]{9}$', ck_employees__personal_email,
--     the marital_status / blood_group enums), so approving actually applies
--     instead of failing.
--
-- One row is deliberately a tax-regime election on `employee_statutory`. That
-- table is keyed on employee_id with NO id column, so `apply_change_request`
-- cannot write it (011 §3 updates satellites `WHERE id = $2 AND employee_id =
-- $3`). It is here on purpose: the console has to be able to show the honest
-- "approved — record it on the employee's record yourself" outcome, and a queue
-- where every row applies cleanly would hide that.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'seed 063: demo employee change requests for the HR maker-checker queue', true);
SELECT set_config('app.source', 'migration', true);

DO $seed$
DECLARE
  v_enabled  boolean;
  v_bloods   text[] := ARRAY['O+', 'B+', 'A+', 'AB+'];
  v_fallback uuid;
  emp        record;
  v_n        integer;
BEGIN
  SELECT (value #>> '{}')::boolean INTO v_enabled
    FROM public.settings WHERE key = 'seed_demo_data' LIMIT 1;
  IF v_enabled IS NOT TRUE THEN
    RAISE NOTICE 'seed 063 skipped: settings.seed_demo_data is not true';
    RETURN;
  END IF;

  -- `requested_by` references PROFILES and is NOT NULL. Most demo employees have
  -- their own login and that is the honest requester; where one has not been
  -- created yet the oldest profile (the owner account) stands in, which is the
  -- real "HR recorded this on the employee's behalf" case the table supports.
  SELECT id INTO v_fallback FROM public.profiles ORDER BY created_at, id LIMIT 1;
  IF v_fallback IS NULL THEN
    RAISE NOTICE 'seed 063 skipped: no profile exists to attribute a request to';
    RETURN;
  END IF;

  FOR emp IN
    SELECT e.id, e.employee_code,
           COALESCE(e.profile_id, v_fallback) AS profile_id,
           e.mobile, e.personal_email, e.blood_group, e.marital_status,
           row_number() OVER (ORDER BY e.employee_code) AS n
      FROM public.employees e
     WHERE e.deleted_at IS NULL
     ORDER BY e.employee_code
     LIMIT 5
  LOOP
    v_n := emp.n::integer;

    -- 1. Mobile number — the commonest self-service correction there is.
    IF v_n IN (1, 3, 5)
       AND NOT EXISTS (SELECT 1 FROM public.employee_change_requests
                        WHERE employee_id = emp.id AND entity_table = 'employees'
                          AND field_name = 'mobile') THEN
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, field_name, field_label,
         old_value, new_value, is_sensitive, requested_at)
      VALUES
        (emp.id, emp.profile_id, 'employees', 'mobile', 'Mobile number',
         to_jsonb(emp.mobile),
         to_jsonb('9' || lpad(((800000000 + v_n * 7919) % 1000000000)::text, 9, '0')),
         false, now() - (v_n * interval '9 hours'));
    END IF;

    -- 2. Personal email — arrives with the new number often enough.
    IF v_n IN (2, 4)
       AND NOT EXISTS (SELECT 1 FROM public.employee_change_requests
                        WHERE employee_id = emp.id AND entity_table = 'employees'
                          AND field_name = 'personal_email') THEN
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, field_name, field_label,
         old_value, new_value, is_sensitive, requested_at)
      VALUES
        (emp.id, emp.profile_id, 'employees', 'personal_email', 'Personal email',
         to_jsonb(emp.personal_email),
         to_jsonb(lower(emp.employee_code) || '.tt@gmail.com'),
         false, now() - (v_n * interval '31 hours'));
    END IF;

    -- 3. Blood group — the one HR is asked for after a first-aid drill.
    IF v_n = 2
       AND emp.blood_group = 'unknown'
       AND NOT EXISTS (SELECT 1 FROM public.employee_change_requests
                        WHERE employee_id = emp.id AND entity_table = 'employees'
                          AND field_name = 'blood_group') THEN
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, field_name, field_label,
         old_value, new_value, is_sensitive, requested_at)
      VALUES
        (emp.id, emp.profile_id, 'employees', 'blood_group', 'Blood group',
         to_jsonb(emp.blood_group::text),
         to_jsonb(v_bloods[1 + (v_n % 4)]),
         false, now() - interval '2 days');
    END IF;

    -- 4. Marital status — a real life event, and a sensitive one.
    IF v_n = 4
       AND coalesce(emp.marital_status::text, 'single') <> 'married'
       AND NOT EXISTS (SELECT 1 FROM public.employee_change_requests
                        WHERE employee_id = emp.id AND entity_table = 'employees'
                          AND field_name = 'marital_status') THEN
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, field_name, field_label,
         old_value, new_value, is_sensitive, requested_at)
      VALUES
        (emp.id, emp.profile_id, 'employees', 'marital_status', 'Marital status',
         to_jsonb(emp.marital_status::text), to_jsonb('married'::text),
         true, now() - interval '4 days');
    END IF;

    -- 5. Tax regime — the row the applier structurally cannot write.
    IF v_n = 1
       AND EXISTS (SELECT 1 FROM public.employee_statutory WHERE employee_id = emp.id)
       AND NOT EXISTS (SELECT 1 FROM public.employee_change_requests
                        WHERE employee_id = emp.id
                          AND entity_table = 'employee_statutory'
                          AND field_name = 'tax_regime') THEN
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, entity_id, field_name, field_label,
         old_value, new_value, is_sensitive, requested_at)
      -- NULL::uuid and the ::text cast are deliberate: a bare NULL and an
      -- unknown-typed CASE would leave to_jsonb() with no polymorphic type.
      SELECT emp.id, emp.profile_id, 'employee_statutory', NULL::uuid, 'tax_regime',
             'Income-tax regime',
             to_jsonb(s.tax_regime),
             to_jsonb((CASE WHEN s.tax_regime = 'new' THEN 'old' ELSE 'new' END)::text),
             true, now() - interval '6 days'
        FROM public.employee_statutory s
       WHERE s.employee_id = emp.id;
    END IF;
  END LOOP;
END $seed$;

COMMIT;
