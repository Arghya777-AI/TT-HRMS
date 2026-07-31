-- =============================================================================
-- 091 · Voiding a punch was impossible, for everybody
--
-- `attendance_punches` is append-only: DELETE is refused outright and UPDATE is refused
-- unless it changes ONLY the four void columns. The guard enforced that by comparing the
-- whole row:
--
--     IF (to_jsonb(NEW) - v_void_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_void_cols)
--
-- The table has THREE `GENERATED ALWAYS … STORED` columns — `ist_date`, `ist_time` and
-- `effective_date` — and a generated column is NOT POPULATED IN NEW inside a BEFORE
-- trigger. OLD carries its stored value, NEW carries NULL, so the two sides always differ
-- and the guard raised on every void it was ever asked to allow:
--
--     void may change only the void columns (is_voided, voided_by, voided_at, void_reason)
--
-- Nothing could void a punch. Not raw SQL with `app.allow_punch_void` set, and not the
-- `void-punch` edge function, whose entire purpose is this UPDATE — so the sanctioned path
-- for correcting a mistaken scan has never worked. Found while trying to remove two
-- diagnostic punches, which is the only reason anybody looked.
--
-- THE FIX LOSES NO PROTECTION. A generated column cannot be assigned by any writer —
-- Postgres rejects the attempt — so its value is a pure function of columns the comparison
-- still covers. Excluding the three from the diff removes exactly the noise that made the
-- check impossible to satisfy and keeps every column a voider could actually tamper with
-- under guard.
-- =============================================================================

BEGIN;

SELECT set_config('app.reason', 'migration 091: the append-only guard ignored generated columns, making every void impossible', true);
SELECT set_config('app.source', 'migration', true);

CREATE OR REPLACE FUNCTION public.attendance_punches_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_void_cols text[] := ARRAY['is_voided','voided_by','voided_at','void_reason'];
  /*
    GENERATED ALWAYS columns are NULL in NEW inside a BEFORE trigger while OLD holds the
    stored value, so leaving them in the diff made it unsatisfiable. They cannot be written
    by anyone, so ignoring them here removes noise and no protection. Keep this list in step
    with the table: ist_date, ist_time and effective_date are generated as of migration 091.
  */
  v_generated text[] := ARRAY['ist_date','ist_time','effective_date'];
  v_ignore    text[] := v_void_cols || v_generated;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_punches is append-only (void instead of delete)'
      USING errcode = '0A000';
  END IF;
  IF coalesce(current_setting('app.allow_punch_void', true), '') <> 'on' THEN
    RAISE EXCEPTION 'attendance_punches is append-only (voids go through the void-punch function)'
      USING errcode = '0A000';
  END IF;
  IF (to_jsonb(NEW) - v_ignore) IS DISTINCT FROM (to_jsonb(OLD) - v_ignore) THEN
    RAISE EXCEPTION 'void may change only the void columns (%)', array_to_string(v_void_cols, ', ')
      USING errcode = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.attendance_punches_append_only() IS
  'Append-only guard: DELETE never, UPDATE only when it changes the four void columns. Generated columns (ist_date, ist_time, effective_date) are excluded from the comparison because a BEFORE trigger sees them as NULL in NEW — including them made every void impossible, which is the bug migration 091 fixes. They cannot be written by any caller, so excluding them weakens nothing.';

COMMIT;
