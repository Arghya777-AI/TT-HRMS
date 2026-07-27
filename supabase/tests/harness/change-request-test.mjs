#!/usr/bin/env node
/**
 * FUNCTIONAL test of public.decide_change_request (migration 062) against a real
 * Postgres with every migration applied. Proves:
 *   1. the reason floor (no X-Reason ⇒ refused)
 *   2. reject needs a comment of >= 10 chars, and stamps the row
 *   3. approve applies an `employees` whitelist column IN THE SAME TRANSACTION
 *   4. the audit trail carries the decision reason and the field-level diff
 *   5. a satellite keyed only on employee_id is approved-but-not-written
 *   6. an open governing approval chain refuses the decision here
 *   7. only an admin-with-scope may decide, and never the subject
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PGPORT_TEST ?? 54371);
// Resolved from this file, never from an absolute path baked in at authoring
// time — the other harnesses (validate/engine/self-service) do the same, and a
// hard-coded checkout or scratchpad path makes the test runnable on one machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const DATA = join(process.env.TMPDIR ?? "/tmp", `pgdata-chq-${PORT}`);

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: DATA, user: "postgres", password: "postgres", port: PORT, persistent: false,
});
await server.initialise();
await server.start();
await server.createDatabase("chq");
const db = new pg.Client({
  host: "localhost", port: PORT, user: "postgres", password: "postgres", database: "chq",
});
await db.connect();

const fails = (fn) => fn().then(() => null, (e) => e.message);

try {
  await db.query(readFileSync(join(HERE, "supabase-shim.sql"), "utf8"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try { await db.query(readFileSync(join(MIGRATIONS, f), "utf8")); }
    catch (e) { console.log(`SETUP FAIL ${f}: ${e.message}`); process.exit(1); }
  }
  console.log("migrations applied\n");

  // ---- actors ---------------------------------------------------------------
  // The FIRST auth user is bootstrapped to super_admin (migration 004), so make
  // a throwaway to absorb it, then the HR decider, then the employee.
  await db.query(`INSERT INTO auth.users (email, raw_user_meta_data)
                  VALUES ('bootstrap@tamarindtree.co','{"full_name":"Bootstrap"}'::jsonb)`);
  const hr = (await db.query(`INSERT INTO auth.users (email, raw_user_meta_data)
    VALUES ('priya.hr@tamarindtree.co','{"full_name":"Priya HR"}'::jsonb) RETURNING id`)).rows[0].id;
  const staff = (await db.query(`INSERT INTO auth.users (email, raw_user_meta_data)
    VALUES ('rakesh@tamarindtree.co','{"full_name":"Rakesh Kumar"}'::jsonb) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO public.user_roles (user_id, role, granted_reason)
                  VALUES ($1,'super_admin','functional test: HR decider')`, [hr]);
  // handle_new_user already gives a normal joiner the 'employee' role.
  await db.query(`INSERT INTO public.user_roles (user_id, role, granted_reason)
                  SELECT $1,'employee','functional test: subject'
                  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles
                                    WHERE user_id=$1 AND role='employee' AND revoked_at IS NULL)`, [staff]);

  const emp = (await db.query(`
    INSERT INTO public.employees
      (company_id, first_name, last_name, display_name, employment_type,
       employment_status, date_of_join, department_id, designation_id, location_id,
       shift_id, attendance_policy_id, weekly_off_rule_id, holiday_calendar_id,
       punch_mode, profile_id, mobile, blood_group)
    SELECT (SELECT id FROM public.companies WHERE code='TT'),
           'Rakesh','Kumar','Rakesh Kumar','permanent','active', DATE '2026-01-01',
           (SELECT id FROM public.departments WHERE code='BANQ'),
           (SELECT id FROM public.designations WHERE code='STEWARD'),
           (SELECT id FROM public.locations WHERE code='TTT-VENUE'),
           (SELECT id FROM public.shifts WHERE code='G'),
           (SELECT id FROM public.attendance_policies WHERE code='AP-OPS'),
           (SELECT id FROM public.weekly_off_rules WHERE code='WO-MIDWEEK-TUE'),
           (SELECT id FROM public.holiday_calendars LIMIT 1),
           'multi_punch', $1, '9880011223', 'unknown'
    RETURNING id, employee_code`, [staff])).rows[0];
  console.log(`employee ${emp.employee_code} created\n`);

  /** Values are JS values; jsonb columns are given real JSON, never a bare word. */
  const newRequest = async (fields) => {
    const r = await db.query(`
      INSERT INTO public.employee_change_requests
        (employee_id, requested_by, entity_table, entity_id, field_name, field_label,
         old_value, new_value, is_sensitive)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id`,
      [emp.id, staff, fields.table, fields.entityId ?? null, fields.field, fields.label,
       JSON.stringify(fields.oldValue ?? null), JSON.stringify(fields.newValue),
       fields.sensitive ?? false]);
    return r.rows[0].id;
  };

  /** One decision, in ONE transaction, exactly as PostgREST would run it. */
  const decide = async (id, decision, comment, reason, actor = hr) => {
    await db.query("BEGIN");
    try {
      await db.query(`SELECT set_config('app.actor_id', $1::text, true)`, [actor]);
      if (reason !== null) {
        await db.query(`SELECT set_config('app.reason', $1, true)`, [reason]);
      }
      const r = await db.query(
        `SELECT public.decide_change_request($1,$2,$3) AS out`, [id, decision, comment]);
      await db.query("COMMIT");
      return r.rows[0].out;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  };

  // ---- 1. the reason floor --------------------------------------------------
  console.log("1. Every decision needs an audit reason");
  const r1 = await newRequest({
    table: "employees", field: "mobile", label: "Mobile number",
    oldValue: "9880011223", newValue: "9880099887",
  });
  const noReason = await fails(() => decide(r1, "approve", null, null));
  check("no X-Reason ⇒ refused", (noReason ?? "").includes("audit reason"), noReason ?? "accepted!");
  const shortReason = await fails(() => decide(r1, "approve", null, "too short"));
  check("a 9-character reason ⇒ refused", (shortReason ?? "").includes("audit reason"), shortReason ?? "accepted!");

  // ---- 2. authorisation ----------------------------------------------------
  console.log("\n2. Authorisation is re-asserted inside the definer");
  const asSubject = await fails(() =>
    decide(r1, "approve", null, "the subject trying to approve their own change", staff));
  check("the subject cannot decide their own change",
    (asSubject ?? "").includes("not allowed") || (asSubject ?? "").includes("your own record"),
    asSubject ?? "accepted!");

  // ---- 3. approve applies the employees column -----------------------------
  console.log("\n3. Approve stamps AND applies, in one transaction");
  const out3 = await decide(r1, "approve", "verified against the new SIM card letter",
    "approved after checking the employee's new SIM registration letter");
  check("returns decision=approved", out3.decision === "approved", JSON.stringify(out3));
  check("returns status=applied", out3.status === "applied", JSON.stringify(out3));
  check("returns applied=true", out3.applied === true, JSON.stringify(out3));
  const mob = await db.query(`SELECT mobile FROM public.employees WHERE id=$1`, [emp.id]);
  check("employees.mobile actually changed", mob.rows[0].mobile === "9880099887", mob.rows[0].mobile);
  const stamped = await db.query(
    `SELECT status, decided_by, decision_comment, applied_at, apply_error
       FROM public.employee_change_requests WHERE id=$1`, [r1]);
  check("decided_by is the HR actor", stamped.rows[0].decided_by === hr);
  check("decision_comment stored", stamped.rows[0].decision_comment === "verified against the new SIM card letter");
  check("applied_at stamped", stamped.rows[0].applied_at !== null);
  check("no apply_error", stamped.rows[0].apply_error === null);

  const alreadyDone = await fails(() =>
    decide(r1, "approve", null, "trying to decide an applied request twice over"));
  check("an applied request cannot be decided again",
    (alreadyDone ?? "").includes("only a pending request"), alreadyDone ?? "accepted!");

  // ---- 4. the audit trail --------------------------------------------------
  console.log("\n4. The decision and the field change are both audited with a reason");
  const auditEcr = await db.query(
    `SELECT reason, field_name, old_value, new_value FROM public.audit_log
      WHERE entity_table='public.employee_change_requests' AND entity_id=$1 AND action='update'
      ORDER BY occurred_at DESC`, [r1]);
  check("audit rows exist for the decision", auditEcr.rows.length > 0, `${auditEcr.rows.length} rows`);
  check("the decision reason names the request",
    auditEcr.rows.some((r) => (r.reason ?? "").includes("approved")),
    JSON.stringify(auditEcr.rows.map((r) => r.reason).slice(0, 3)));
  const auditEmp = await db.query(
    `SELECT reason, field_name, old_value, new_value FROM public.audit_log
      WHERE entity_table='public.employees' AND entity_id=$1 AND field_name='mobile'`, [emp.id]);
  check("the employees.mobile change is audited field-level", auditEmp.rows.length === 1,
    JSON.stringify(auditEmp.rows));
  check("the audit row carries the before and after",
    auditEmp.rows[0] !== undefined &&
    String(auditEmp.rows[0].old_value).includes("9880011223") &&
    String(auditEmp.rows[0].new_value).includes("9880099887"),
    JSON.stringify(auditEmp.rows[0]));
  check("the employees audit row names the change request",
    (auditEmp.rows[0]?.reason ?? "").includes("change request"), auditEmp.rows[0]?.reason ?? "");

  // ---- 5. reject -----------------------------------------------------------
  console.log("\n5. Rejection demands a comment the employee will read");
  const r5 = await newRequest({
    table: "employees", field: "blood_group", label: "Blood group",
    oldValue: "unknown", newValue: "O+",
  });
  const shortComment = await fails(() => decide(r5, "reject", "no",
    "rejecting because the request has no supporting evidence at all"));
  check("a 2-character comment ⇒ refused",
    (shortComment ?? "").includes("at least 10 characters"), shortComment ?? "accepted!");
  const out5 = await decide(r5, "reject", "Send the pathology report and we will record it.",
    "rejected pending a pathology report for the blood group claim");
  check("returns decision=rejected", out5.decision === "rejected", JSON.stringify(out5));
  const rejected = await db.query(
    `SELECT status, decision_comment, applied_at FROM public.employee_change_requests WHERE id=$1`, [r5]);
  check("status=rejected", rejected.rows[0].status === "rejected");
  check("applied_at stays NULL on rejection", rejected.rows[0].applied_at === null);
  const bg = await db.query(`SELECT blood_group::text AS bg FROM public.employees WHERE id=$1`, [emp.id]);
  check("the record was NOT touched by a rejection", bg.rows[0].bg === "unknown", bg.rows[0].bg);

  // ---- 6. the satellite the applier cannot write ---------------------------
  console.log("\n6. employee_statutory has no id column, so approve ≠ applied");
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.reason','functional test: statutory row for the regime election', true)`);
  await db.query(`INSERT INTO public.employee_statutory (employee_id, tax_regime) VALUES ($1,'new')`, [emp.id]);
  await db.query("COMMIT");
  const r6 = await newRequest({
    table: "employee_statutory", field: "tax_regime", label: "Income-tax regime",
    oldValue: "new", newValue: "old", sensitive: true,
  });
  const out6 = await decide(r6, "approve", "regime election accepted for this financial year",
    "approving the employee's income-tax regime election for FY2026-27");
  check("appliable=false is reported", out6.appliable === false, JSON.stringify(out6));
  check("status stays approved (not failed)", out6.status === "approved", JSON.stringify(out6));
  check("applied=false", out6.applied === false, JSON.stringify(out6));
  check("no apply_error was invented", out6.apply_error === null, JSON.stringify(out6));
  const regime = await db.query(`SELECT tax_regime FROM public.employee_statutory WHERE employee_id=$1`, [emp.id]);
  check("the regime is untouched — HR records it", regime.rows[0].tax_regime === "new", regime.rows[0].tax_regime);

  // ---- 7. an open governing chain outranks this screen ---------------------
  console.log("\n7. An open approval chain refuses the decision here");
  const r7 = await newRequest({
    table: "employees", field: "personal_email", label: "Personal email",
    oldValue: null, newValue: "rakesh.k@gmail.com",
  });
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.actor_id', $1::text, true)`, [staff]);
  await db.query(`SELECT set_config('app.reason','functional test: raise the governing profile-change request', true)`);
  const gov = await db.query(
    `SELECT public.create_approval_request('PROFILE_CHANGE', $1, $2, 'Personal email change',
            '{"summary":"My old address bounces, please use the new one."}'::jsonb) AS id`,
    [emp.id, r7]);
  await db.query("COMMIT");
  check("a governing approval request was created", gov.rows[0].id !== null);
  const blocked = await fails(() => decide(r7, "approve", null,
    "trying to apply while the workflow chain is still open"));
  check("an open chain ⇒ refused, with the request number",
    (blocked ?? "").includes("governed by approval request"), blocked ?? "accepted!");
  const summary = await db.query(
    `SELECT summary->>'summary' AS note, request_number, status::text AS status, total_levels
       FROM public.approval_requests WHERE detail_table='employee_change_requests' AND detail_id=$1`, [r7]);
  check("the employee's sentence is readable from the workflow row",
    summary.rows[0].note === "My old address bounces, please use the new one.",
    JSON.stringify(summary.rows[0]));

  // Close the chain as approved, then the same decision must go through.
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.actor_id', $1::text, true)`, [hr]);
  await db.query(`SELECT set_config('app.reason','functional test: approve the governing chain', true)`);
  await db.query(`SELECT public.act_on_approval($1,'approve','looks right to HR')`,
    [(await db.query(`SELECT id FROM public.approval_requests WHERE detail_id=$1`, [r7])).rows[0].id]);
  await db.query("COMMIT");
  const chainState = await db.query(
    `SELECT status::text AS status FROM public.approval_requests WHERE detail_id=$1`, [r7]);
  console.log(`     chain is now ${chainState.rows[0].status}`);
  if (chainState.rows[0].status === "approved") {
    const out7 = await decide(r7, "approve", "the chain approved it, applying the address",
      "applying the personal email change its approval chain already cleared");
    check("once the chain is approved the field applies", out7.status === "applied", JSON.stringify(out7));
    const mail = await db.query(`SELECT personal_email FROM public.employees WHERE id=$1`, [emp.id]);
    check("employees.personal_email changed", mail.rows[0].personal_email === "rakesh.k@gmail.com",
      mail.rows[0].personal_email);
  } else {
    const stillBlocked = await fails(() => decide(r7, "approve", null,
      "trying again while the chain has not finished"));
    check("a chain still short of approved keeps refusing", stillBlocked !== null, "accepted!");
  }

  // ---- 8. the client role really cannot UPDATE the table -------------------
  console.log("\n8. Why the RPC exists: authenticated holds no UPDATE");
  const priv = await db.query(
    `SELECT has_table_privilege('authenticated','public.employee_change_requests','UPDATE') AS upd,
            has_table_privilege('authenticated','public.employee_change_requests','INSERT') AS ins,
            has_function_privilege('authenticated','public.decide_change_request(uuid,text,text)','EXECUTE') AS ex`);
  check("authenticated cannot UPDATE employee_change_requests", priv.rows[0].upd === false);
  check("authenticated CAN insert one", priv.rows[0].ins === true);
  check("authenticated can execute decide_change_request", priv.rows[0].ex === true);

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await db.end().catch(() => {});
  await server.stop().catch(() => {});
}
process.exit(fail === 0 ? 0 : 1);
