#!/usr/bin/env node
/**
 * FUNCTIONAL test of the attendance engine — the core of the product.
 *
 * Proves, against a real Postgres with all migrations + seeds applied:
 *  1. Seeds produced the expected reference data.
 *  2. First scan of the IST day = check-in, LAST scan = check-out, middles
 *     ignored (the client's headline rule).
 *  3. A single scan is NOT marked absent (half_day_flag_review + anomaly flag).
 *  4. A post-midnight night-shift punch is attributed to the PREVIOUS business
 *     date (the 05:00 cutover), not the UTC/IST calendar date.
 *  5. Recompute is idempotent — same inputs, same outputs.
 *  6. The append-only punch log rejects UPDATE/DELETE.
 *  7. The audit engine wrote field-level rows with a hash chain that verifies.
 *
 * Usage: PGPORT_TEST=54360 node engine-test.mjs
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PGPORT_TEST ?? 54360);
const DATA = join(HERE, `pgdata-engine-${PORT}`);
const MIGRATIONS = join(HERE, "..", "..", "migrations");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: DATA, user: "postgres", password: "postgres", port: PORT, persistent: false,
});
await server.initialise();
await server.start();
await server.createDatabase("engine");
const db = new pg.Client({
  host: "localhost", port: PORT, user: "postgres", password: "postgres", database: "engine",
});
await db.connect();

try {
  await db.query(readFileSync(join(HERE, "supabase-shim.sql"), "utf8"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      console.log(`SETUP FAIL ${f}: ${e.message}`);
      process.exit(1);
    }
  }
  console.log("migrations applied\n");

  // ---- 1. Seed sanity -------------------------------------------------------
  console.log("1. Seeded reference data");
  const seeded = await db.query(`
    SELECT
      (SELECT count(*) FROM public.companies)          AS companies,
      (SELECT count(*) FROM public.departments)        AS departments,
      (SELECT count(*) FROM public.shifts)             AS shifts,
      (SELECT count(*) FROM public.designations)       AS designations,
      (SELECT count(*) FROM public.leave_types)        AS leave_types,
      (SELECT count(*) FROM public.salary_components)  AS components,
      (SELECT count(*) FROM public.attendance_policies) AS policies,
      (SELECT count(*) FROM public.holidays)           AS holidays,
      (SELECT count(*) FROM public.pay_periods)        AS pay_periods,
      (SELECT count(*) FROM public.settings)           AS settings`);
  const s = seeded.rows[0];
  console.log(`     ${JSON.stringify(s)}`);
  check("company seeded", Number(s.companies) >= 1);
  check("13 departments seeded", Number(s.departments) === 13, `got ${s.departments}`);
  check("11 shifts seeded", Number(s.shifts) === 11, `got ${s.shifts}`);
  check("leave types seeded", Number(s.leave_types) >= 10, `got ${s.leave_types}`);
  check("salary components seeded", Number(s.components) >= 25, `got ${s.components}`);
  check("attendance policies seeded", Number(s.policies) >= 3, `got ${s.policies}`);
  check("pay periods seeded (FY2026-27)", Number(s.pay_periods) >= 12, `got ${s.pay_periods}`);
  check("settings seeded", Number(s.settings) >= 20, `got ${s.settings}`);

  // ---- fixture: one employee on the General shift --------------------------
  const emp = await db.query(`
    WITH c AS (SELECT id FROM public.companies WHERE code='TT'),
    ins AS (
      INSERT INTO public.employees
        (company_id, first_name, last_name, display_name, employment_type,
         employment_status, date_of_join, department_id, designation_id,
         location_id, shift_id, attendance_policy_id, weekly_off_rule_id,
         holiday_calendar_id, punch_mode)
      SELECT c.id, 'Rakesh', 'Kumar', 'Rakesh Kumar', 'permanent', 'active',
             DATE '2026-01-01',
             (SELECT id FROM public.departments WHERE code='BANQ'),
             (SELECT id FROM public.designations WHERE code='STEWARD'),
             (SELECT id FROM public.locations WHERE code='TTT-VENUE'),
             (SELECT id FROM public.shifts WHERE code='G'),
             (SELECT id FROM public.attendance_policies WHERE code='AP-OPS'),
             (SELECT id FROM public.weekly_off_rules WHERE code='WO-MIDWEEK-TUE'),
             (SELECT id FROM public.holiday_calendars LIMIT 1),
             'multi_punch'
      FROM c RETURNING id, employee_code)
    SELECT * FROM ins`);
  const employeeId = emp.rows[0]?.id;
  check("employee created with generated code", /^TT\d{4}$/.test(emp.rows[0]?.employee_code ?? ""),
    `code=${emp.rows[0]?.employee_code}`);

  /**
   * Insert a punch through the REAL kiosk path: a `kiosk_face` punch is only
   * legal with a face_match_log row (ck_ap__face_match), which is how the
   * schema forces every biometric decision to be recorded server-side.
   */
  const deviceRow = await db.query(
    `SELECT id, device_code FROM public.kiosk_devices WHERE deleted_at IS NULL ORDER BY device_code LIMIT 1`);
  const deviceId = deviceRow.rows[0]?.id ?? null;
  check("kiosk device seeded (TT-GATE-01)", deviceRow.rows[0]?.device_code === "TT-GATE-01",
    `got ${deviceRow.rows[0]?.device_code}`);

  const kioskPunch = async (empId, isoDate, hhmm) => {
    const match = await db.query(
      `INSERT INTO secure.face_match_log
         (attempted_at, kiosk_device_id, candidate_set_size, outcome,
          matched_employee_id, best_distance, best_confidence,
          runner_up_distance, margin, threshold_used, model_version,
          detector_score, latency_ms)
       VALUES (($1::date + $2::time) AT TIME ZONE 'Asia/Kolkata', $4,
               12, 'matched', $3, 0.31000, 0.78000, 0.52000, 0.21000,
               0.62000, 'face_recognition_v1', 0.9100, 640)
       RETURNING id`,
      [isoDate, hhmm, empId, deviceId],
    );
    await db.query(
      `INSERT INTO public.attendance_punches
         (employee_id, punched_at, source, direction, kiosk_device_id,
          face_match_log_id, match_confidence, match_distance)
       VALUES ($1, ($2::date + $3::time) AT TIME ZONE 'Asia/Kolkata',
               'kiosk_face', 'undetermined', $5, $4, 0.78000, 0.31000)`,
      [empId, isoDate, hhmm, match.rows[0].id, deviceId],
    );
  };

  // ---- 2. first scan = IN, last scan = OUT ---------------------------------
  console.log("\n2. First scan = check-in, LAST scan = check-out (IST)");
  // Wed 15-Jul-2026 (not the Tuesday weekly off). IST times 09:24, 13:10, 14:05, 18:47.
  const day = "2026-07-15";
  for (const hhmm of ["09:24", "13:10", "14:05", "18:47"]) {
    await kioskPunch(employeeId, day, hhmm);
  }
  const computed = await db.query(`SELECT * FROM public.compute_attendance_day($1, $2)`, [employeeId, day]);
  const d = computed.rows[0];
  const istOf = async (ts) =>
    (await db.query(`SELECT to_char(util.ist_ts($1::timestamptz),'HH24:MI') AS t`, [ts])).rows[0].t;
  const firstIn = d?.first_in_at ? await istOf(d.first_in_at) : null;
  const lastOut = d?.last_out_at ? await istOf(d.last_out_at) : null;
  console.log(`     status=${d?.status} first_in=${firstIn} last_out=${lastOut} punches=${d?.punch_count} worked=${d?.total_worked_minutes}m late=${d?.late_minutes}m`);
  check("first_in is the FIRST scan (09:24)", firstIn === "09:24", `got ${firstIn}`);
  check("last_out is the LAST scan (18:47)", lastOut === "18:47", `got ${lastOut}`);
  check("all 4 punches counted", Number(d?.punch_count) === 4, `got ${d?.punch_count}`);
  check("status is present", d?.status === "present", `got ${d?.status}`);
  // 09:24→18:47 = 563 min gross span. The engine derives the break from the
  // INTERIOR scans (13:10→14:05 = 55 min) rather than applying the shift's flat
  // 60 min, because real break punches exist (§7.4). 563 − 55 = 508.
  check("worked = span − measured interior break (563−55)", Number(d?.total_worked_minutes) === 508,
    `got ${d?.total_worked_minutes}`);
  check("break derived from the middle scans", Number(d?.break_minutes) === 55,
    `got ${d?.break_minutes}`);
  // Shift G starts 09:30 → arriving 09:24 is EARLY, so zero late minutes.
  check("early arrival is not late", Number(d?.late_minutes) === 0, `got ${d?.late_minutes}`);

  // ---- 3. single scan is not absent ---------------------------------------
  console.log("\n3. A single scan is an exception, never an absence");
  const day2 = "2026-07-16";
  await kioskPunch(employeeId, day2, "09:55");
  const one = (await db.query(`SELECT * FROM public.compute_attendance_day($1, $2)`, [employeeId, day2])).rows[0];
  console.log(`     status=${one?.status} punches=${one?.punch_count} last_out=${one?.last_out_at} flags=${JSON.stringify(one?.anomaly_flags)}`);
  check("single scan is NOT absent", one?.status !== "absent", `got ${one?.status}`);
  check("no check-out recorded from one scan", one?.last_out_at === null);
  check("flagged for review", Array.isArray(one?.anomaly_flags) && one.anomaly_flags.length > 0,
    JSON.stringify(one?.anomaly_flags));

  // ---- 4. night-shift attribution across midnight -------------------------
  console.log("\n4. Post-midnight punch belongs to the PREVIOUS business date");
  const guard = await db.query(`
    INSERT INTO public.employees
      (company_id, first_name, last_name, display_name, employment_type, employment_status,
       date_of_join, department_id, designation_id, location_id, shift_id,
       attendance_policy_id, weekly_off_rule_id, punch_mode)
    SELECT (SELECT id FROM public.companies WHERE code='TT'), 'Suresh','Naik','Suresh Naik',
           'permanent','active', DATE '2026-01-01',
           (SELECT id FROM public.departments WHERE code='SEC'),
           (SELECT id FROM public.designations WHERE code='SEC-GUARD'),
           (SELECT id FROM public.locations WHERE code='TTT-VENUE'),
           (SELECT id FROM public.shifts WHERE code='SEC-N'),
           (SELECT id FROM public.attendance_policies WHERE code='AP-SECURITY'),
           (SELECT id FROM public.weekly_off_rules WHERE code='WO-ROSTER'),
           'multi_punch'
    RETURNING id`);
  const guardId = guard.rows[0].id;
  // Night shift SEC-N is 19:00→07:00 with a 05:00 cutover.
  await kioskPunch(guardId, "2026-07-20", "18:52");
  await kioskPunch(guardId, "2026-07-21", "03:15");
  const nightRows = await db.query(
    `SELECT to_char(util.ist_ts(punched_at),'YYYY-MM-DD HH24:MI') AS ist,
            ist_date::text, business_date::text, effective_date::text
     FROM public.attendance_punches WHERE employee_id=$1 ORDER BY punched_at`, [guardId]);
  for (const r of nightRows.rows) console.log(`     ${r.ist} IST → ist_date=${r.ist_date} business=${r.business_date} effective=${r.effective_date}`);
  const post = nightRows.rows[1];
  check("03:15 IST punch has IST calendar date 21-Jul", post.ist_date === "2026-07-21");
  check("…but effective (business) date is 20-Jul", post.effective_date === "2026-07-20",
    `got ${post.effective_date}`);
  const night = (await db.query(`SELECT * FROM public.compute_attendance_day($1, $2)`,
    [guardId, "2026-07-20"])).rows[0];
  console.log(`     20-Jul: status=${night?.status} punches=${night?.punch_count} worked=${night?.total_worked_minutes}m`);
  check("both night punches land on one business day", Number(night?.punch_count) === 2,
    `got ${night?.punch_count}`);
  check("night shift worked minutes > 8h", Number(night?.total_worked_minutes) > 480,
    `got ${night?.total_worked_minutes}`);

  // ---- 5. recompute idempotency -------------------------------------------
  console.log("\n5. Recompute is idempotent");
  const before = (await db.query(
    `SELECT status, first_in_at, last_out_at, total_worked_minutes, day_fraction_paid
     FROM public.attendance_days WHERE employee_id=$1 AND ist_date=$2`, [employeeId, day])).rows[0];
  await db.query(`SELECT public.compute_attendance_day($1,$2,'idempotency check',true)`, [employeeId, day]);
  const after = (await db.query(
    `SELECT status, first_in_at, last_out_at, total_worked_minutes, day_fraction_paid
     FROM public.attendance_days WHERE employee_id=$1 AND ist_date=$2`, [employeeId, day])).rows[0];
  check("second run produces identical figures", JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const dayCount = await db.query(
    `SELECT count(*) FROM public.attendance_days WHERE employee_id=$1 AND ist_date=$2`, [employeeId, day]);
  check("exactly one row per (employee, date)", Number(dayCount.rows[0].count) === 1);

  // ---- 6. punch log is append-only ---------------------------------------
  console.log("\n6. Punch log is append-only");
  let updateBlocked = false;
  try {
    await db.query(`UPDATE public.attendance_punches SET punched_at = punched_at + interval '3 hours'
                    WHERE employee_id=$1`, [employeeId]);
  } catch {
    updateBlocked = true;
  }
  await db.query("ROLLBACK").catch(() => {});
  check("UPDATE on a punch is refused", updateBlocked);

  let deleteBlocked = false;
  try {
    await db.query(`DELETE FROM public.attendance_punches WHERE employee_id=$1`, [employeeId]);
  } catch {
    deleteBlocked = true;
  }
  await db.query("ROLLBACK").catch(() => {});
  check("DELETE on a punch is refused", deleteBlocked);

  // ---- 7. audit trail + hash chain ---------------------------------------
  console.log("\n7. Field-level audit with a verifiable hash chain");
  // set_config(..., true) is TRANSACTION-LOCAL, so the reason and the mutation
  // must share one transaction — exactly the contract every edge function
  // follows (app.set_context() then the write, in a single txn).
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.reason','engine test: rename for audit proof', true)`);
  await db.query(`UPDATE public.employees SET preferred_name='Rakesh' WHERE id=$1`, [employeeId]);
  await db.query("COMMIT");
  const audit = await db.query(
    `SELECT entity_table, field_name, old_value::text, new_value::text, reason
     FROM public.audit_log
     WHERE subject_employee_id=$1 AND field_name='preferred_name'
     ORDER BY seq DESC LIMIT 1`, [employeeId]);
  const a = audit.rows[0];
  console.log(`     ${a?.entity_table}.${a?.field_name}: ${a?.old_value} → ${a?.new_value} (${a?.reason})`);
  check("field-level audit row written", a?.field_name === "preferred_name");
  check("audit captured old and new value", a?.new_value?.includes("Rakesh") === true);
  check("audit captured the reason", (a?.reason ?? "").length >= 10);

  const chain = await db.query(
    `SELECT * FROM audit.verify_chain(date '2026-01-01', date '2100-01-01')`);
  check("hash chain verifies with no divergence", chain.rows.length === 0,
    JSON.stringify(chain.rows[0] ?? {}));

  const total = await db.query(`SELECT count(*) FROM public.audit_log`);
  console.log(`     audit rows written during this test: ${total.rows[0].count}`);
  check("audit engine is actually recording", Number(total.rows[0].count) > 10);

  // ---- 8. capability model + punch replay defence (migration 050) ---------
  console.log("\n8. Capability model and punch-replay defence");
  const capCount = await db.query(`SELECT count(*)::int AS n FROM public.role_capabilities`);
  check("capability matrix seeded", capCount.rows[0].n >= 45, `got ${capCount.rows[0].n}`);

  // has_cap() resolves through the role hierarchy, not a hard-coded list.
  const asUser = async (profileId, cap) => {
    const r = await db.query(
      `SELECT app.has_cap($2) AS ok
       FROM (SELECT set_config('app.actor_id', $1::text, true)) _c`,
      [profileId, cap]);
    return r.rows[0].ok === true;
  };
  // profiles.id references auth.users(id), and handle_new_user() (migration 004)
  // mirrors an auth user into profiles — giving the FIRST user super_admin as
  // the documented bootstrap. Create a throwaway first user to absorb that
  // bootstrap, then the real test user, so role assertions are meaningful.
  await db.query(
    `INSERT INTO auth.users (email, raw_user_meta_data)
     VALUES ('bootstrap.admin@tamarindtree.co', '{"full_name":"Bootstrap Admin"}'::jsonb)`);
  const bootstrapRole = await db.query(
    `SELECT ur.role::text AS role FROM public.user_roles ur
     JOIN public.profiles p ON p.id = ur.user_id
     WHERE p.email = 'bootstrap.admin@tamarindtree.co'`);
  check("first user is bootstrapped to super_admin",
    bootstrapRole.rows[0]?.role === "super_admin", `got ${bootstrapRole.rows[0]?.role}`);

  const authUser = await db.query(
    `INSERT INTO auth.users (email, raw_user_meta_data)
     VALUES ('rakesh.test@tamarindtree.co', '{"full_name":"Rakesh Kumar"}'::jsonb)
     RETURNING id`);
  const profileId = authUser.rows[0].id;
  const mirrored = await db.query(`SELECT id FROM public.profiles WHERE id = $1`, [profileId]);
  check("handle_new_user mirrored the auth user into profiles", mirrored.rows.length === 1);
  // The bootstrap grant applies only to the FIRST user, so this one starts with
  // whatever handle_new_user gives a normal joiner (employee, or nothing).
  const seededRoles = await db.query(
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = $1`, [profileId]);
  check("second user is NOT bootstrapped to super_admin",
    !seededRoles.rows.some((r) => r.role === "super_admin"),
    JSON.stringify(seededRoles.rows.map((r) => r.role)));
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.reason','engine test: link profile to employee', true)`);
  await db.query(`UPDATE public.employees SET profile_id=$1 WHERE id=$2`, [profileId, employeeId]);
  await db.query("COMMIT");
  await db.query(
    `INSERT INTO public.user_roles (user_id, role, granted_reason)
     SELECT $1, 'employee', 'engine test: baseline employee role'
     WHERE NOT EXISTS (
       SELECT 1 FROM public.user_roles
       WHERE user_id = $1 AND role = 'employee' AND revoked_at IS NULL)`, [profileId]);

  check("employee holds me.view", await asUser(profileId, "me.view"));
  check("employee does NOT hold payroll.publish", !(await asUser(profileId, "payroll.publish")));
  check("employee does NOT hold role.grant", !(await asUser(profileId, "role.grant")));

  await db.query(
    `INSERT INTO public.user_roles (user_id, role, granted_reason)
     VALUES ($1, 'super_admin', 'engine test: escalate for cap check')`, [profileId]);
  check("super_admin inherits admin caps", await asUser(profileId, "payroll.publish"));
  check("super_admin holds role.grant", await asUser(profileId, "role.grant"));
  const stepUp = await db.query(`SELECT app.cap_requires_step_up('role.grant') AS r`);
  check("role.grant demands MFA step-up", stepUp.rows[0].r === true);

  // Replaying a kiosk client_event_id must be refused across partitions.
  const replayKey = "evt-engine-test-0001";
  await db.query(
    `INSERT INTO public.attendance_punches
       (employee_id, punched_at, source, direction, kiosk_device_id,
        face_match_log_id, idempotency_key)
     VALUES ($1, (date '2026-07-17' + time '09:30') AT TIME ZONE 'Asia/Kolkata',
             'kiosk_face','undetermined',$2,
             (SELECT id FROM secure.face_match_log LIMIT 1), $3)`,
    [employeeId, deviceId, replayKey]);
  let replayBlocked = false;
  try {
    await db.query(
      `INSERT INTO public.attendance_punches
         (employee_id, punched_at, source, direction, kiosk_device_id,
          face_match_log_id, idempotency_key)
       VALUES ($1, (date '2026-07-17' + time '09:31') AT TIME ZONE 'Asia/Kolkata',
               'kiosk_face','undetermined',$2,
               (SELECT id FROM secure.face_match_log LIMIT 1), $3)`,
      [employeeId, deviceId, replayKey]);
  } catch (e) {
    replayBlocked = e.code === "23505";
  }
  await db.query("ROLLBACK").catch(() => {});
  check("replayed client_event_id is refused (23505)", replayBlocked);

  // A heartbeat must not write an audit row (it would flood the chain).
  const auditBefore = await db.query(`SELECT count(*)::int AS n FROM public.audit_log`);
  await db.query(
    `UPDATE public.kiosk_devices
        SET last_seen_at = now(), clock_skew_seconds = 2, app_version = '1.0.1'
      WHERE id = $1`, [deviceId]);
  const auditAfter = await db.query(`SELECT count(*)::int AS n FROM public.audit_log`);
  check("kiosk heartbeat writes zero audit rows",
    auditAfter.rows[0].n === auditBefore.rows[0].n,
    `${auditBefore.rows[0].n} -> ${auditAfter.rows[0].n}`);

  // …but a real config change still audits, with its reason.
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.reason','engine test: relabel the gate device', true)`);
  await db.query(`UPDATE public.kiosk_devices SET label='Main Gate — Guard Post (North)' WHERE id=$1`, [deviceId]);
  await db.query("COMMIT");
  const cfgAudit = await db.query(
    `SELECT field_name FROM public.audit_log
     WHERE entity_table='public.kiosk_devices' AND field_name='label'
     ORDER BY seq DESC LIMIT 1`);
  check("a real config change still audits", cfgAudit.rows[0]?.field_name === "label");

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
} finally {
  await db.end().catch(() => {});
  await server.stop().catch(() => {});
}
process.exit(fail === 0 ? 0 : 1);
