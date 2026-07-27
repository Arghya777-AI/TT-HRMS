#!/usr/bin/env node
/**
 * Proof harness for the roles + IST audit (docs/roles-and-ist.md).
 *
 * Applies every migration to an embedded PG17, then ASSERTS both conclusions
 * against the live catalog instead of asserting them in prose:
 *
 *   Part A — HR is `admin`: the enum has no `hr`, a plain admin holds all 38
 *            non-super capabilities and none of the 12 reserved ones, and
 *            resolve_approver_kind('hr_admin') really does filter on 'admin'.
 *   Part B — every authority window and effective-date default resolves on the
 *            IST civil day, with the session pinned to UTC as on hosted
 *            Supabase (this embedded cluster otherwise inherits the host zone,
 *            which would hide the entire bug class).
 *
 * Run: node supabase/tests/harness/_prove-roles-ist.mjs
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "pgdata-54331");
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const PORT = 54331;

if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: DATA, user: "postgres", password: "postgres", port: PORT, persistent: false,
});
await server.initialise();
await server.start();
await server.createDatabase("hrms_prove");
const c = new pg.Client({
  host: "localhost", port: PORT, user: "postgres", password: "postgres", database: "hrms_prove",
});
await c.connect();

let bad = 0;
const ok = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) bad++;
};

try {
  await c.query(readFileSync(join(HERE, "supabase-shim.sql"), "utf8"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await c.query(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  // Hosted Supabase runs the database in UTC. This embedded cluster inherits the
  // host zone (IST here), which would make CURRENT_DATE look correct and hide
  // the bug. Pin the session to production conditions.
  await c.query(`SET timezone = 'UTC'`);
  console.log("all migrations applied; session timezone forced to UTC\n--- PART A: HR == admin ---");

  const enumVals = (await c.query(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
      WHERE t.typname='app_role' ORDER BY e.enumsortorder`)).rows.map((r) => r.enumlabel);
  ok("app_role has exactly four values and no `hr`",
    enumVals.join(",") === "employee,manager,admin,super_admin", enumVals.join(","));

  const byRole = Object.fromEntries((await c.query(
    `SELECT role::text, count(*)::int AS n FROM public.role_capabilities GROUP BY 1`))
    .rows.map((r) => [r.role, r.n]));
  ok("50 capability rows: 10 employee / 8 manager / 20 admin / 12 super_admin",
    byRole.employee === 10 && byRole.manager === 8 && byRole.admin === 20 && byRole.super_admin === 12,
    JSON.stringify(byRole));

  // handle_new_user() makes the FIRST account in a fresh database super_admin
  // (migration 004 §6, "bootstrap: first user"). Consume that deliberately so
  // the HR account under test is a PLAIN admin, which is the whole point.
  const owner = (await c.query(
    `INSERT INTO auth.users (email) VALUES ('owner@example.test') RETURNING id`)).rows[0].id;
  const bootstrapped = (await c.query(
    `SELECT role::text FROM public.user_roles WHERE user_id=$1 ORDER BY 1`, [owner]))
    .rows.map((r) => r.role);
  ok("bootstrap: the first account becomes super_admin + employee",
    bootstrapped.join(",") === "employee,super_admin", bootstrapped.join(","));

  const hr = (await c.query(
    `INSERT INTO auth.users (email) VALUES ('hr@example.test') RETURNING id`)).rows[0].id;
  await c.query(
    `INSERT INTO public.user_roles (user_id, role, granted_reason)
     VALUES ($1,'admin','proof harness: HR staff are granted the admin role')`, [hr]);
  await c.query(`SELECT set_config('app.actor_id', $1, false)`, [hr]);
  const hrRoles = (await c.query(
    `SELECT role::text FROM public.user_roles WHERE user_id=$1 AND revoked_at IS NULL ORDER BY 1`, [hr]))
    .rows.map((r) => r.role);
  ok("the HR account under test holds admin + employee, NOT super_admin",
    hrRoles.join(",") === "admin,employee", hrRoles.join(","));

  const caps = (await c.query(`
    SELECT rc.capability, bool_or(rc.role = 'super_admin') AS super_only,
           app.has_cap(rc.capability) AS held
      FROM public.role_capabilities rc GROUP BY rc.capability ORDER BY 1`)).rows;
  const missing = caps.filter((r) => !r.super_only && !r.held).map((r) => r.capability);
  const leaked = caps.filter((r) => r.super_only && r.held).map((r) => r.capability);
  ok("app.has_cap(): admin holds EVERY non-super capability",
    missing.length === 0, missing.join(", ") || "none missing");
  ok("app.has_cap(): admin holds NONE of the reserved capabilities",
    leaked.length === 0, leaked.join(", ") || "none leaked");
  console.log(`      reserved to super_admin: ${caps.filter((r) => r.super_only).map((r) => r.capability).join(", ")}`);

  const mine = (await c.query(`SELECT count(*)::int n FROM public.my_capabilities()`)).rows[0].n;
  ok("my_capabilities() returns exactly the 38 non-super rows", mine === 38, String(mine));

  const su = (await c.query(
    `SELECT count(*)::int n FROM public.role_capabilities WHERE role='super_admin' AND requires_step_up`))
    .rows[0].n;
  ok("11 of the 12 reserved capabilities demand a step-up (admin.super does not)", su === 11, String(su));

  const hrAdminSrc = (await c.query(
    `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='resolve_approver_kind'`)).rows[0].d;
  const hrBranch = hrAdminSrc.split("WHEN 'hr_admin' THEN")[1]?.split("WHEN 'finance'")[0] ?? "";
  ok("resolve_approver_kind('hr_admin') resolves ur.role = 'admin'",
    /ur\.role\s*=\s*'admin'/.test(hrBranch));

  const readPolicies = (await c.query(`
    SELECT policyname FROM pg_policies WHERE schemaname='public'
      AND policyname IN ('user_roles__admin_read','era__admin_read','profiles__admin_read',
                         'role_capabilities__read') ORDER BY 1`)).rows.map((r) => r.policyname);
  ok("an admin may READ all four tables the roles screen shows",
    readPolicies.length === 4, readPolicies.join(", "));

  const writePolicies = (await c.query(`
    SELECT policyname FROM pg_policies WHERE schemaname='public'
      AND policyname IN ('user_roles__super_admin_insert','user_roles__super_admin_update',
                         'era__super_admin_write','role_capabilities__super_admin_write')`)).rows;
  ok("…and only a super_admin may WRITE them", writePolicies.length === 4,
    `${writePolicies.length} write policies found`);

  console.log("\n--- PART B: IST civil day ---");

  for (const [ns, name] of [
    ["app", "is_manager_of"], ["app", "admin_scope_covers"],
    ["public", "resolve_approver_kind"], ["public", "resolve_approvers"],
    ["public", "act_on_approval"],
  ]) {
    const row = (await c.query(`
      SELECT pg_get_functiondef(p.oid) d, COALESCE(p.proconfig,'{}') AS cfg
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname=$1 AND p.proname=$2 LIMIT 1`, [ns, name])).rows[0];
    const usesIstToday = /util\.ist_today\(\)/.test(row.d) && !/CURRENT_DATE/i.test(row.d);
    // Postgres canonicalises the GUC name, so proconfig reads `TimeZone=…`.
    const tzPinned = row.cfg.some((s) => /^TimeZone=Asia\/Kolkata$/i.test(s));
    ok(`${ns}.${name} resolves its date window on the IST civil day`,
      usesIstToday || tzPinned,
      tzPinned ? "pinned TimeZone=Asia/Kolkata" : usesIstToday ? "util.ist_today() in the body" : "NEITHER");
  }

  const defaults = (await c.query(`
    SELECT c.relname||'.'||a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attrdef d
      JOIN pg_class c ON c.oid=d.adrelid
      JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
     WHERE (c.relname,a.attname) IN
       (('employee_role_assignments','effective_from'),('employee_bank_accounts','effective_from'),
        ('employee_swipe_cards','issued_on'),('employee_swipe_cards','valid_from'))
     ORDER BY 1`)).rows;
  ok("all four effective-date defaults were found", defaults.length === 4, String(defaults.length));
  for (const r of defaults) ok(`${r.col} defaults to the IST civil day`, /ist_today/.test(r.def), r.def);

  // The bug class, demonstrated on an instant inside a normal banquet night shift.
  const drift = (await c.query(`
    SELECT (timestamptz '2026-07-25 01:00:00+05:30')::date::text        AS utc_day,
           util.ist_date(timestamptz '2026-07-25 01:00:00+05:30')::text AS ist_day,
           current_setting('TimeZone')                                  AS tz`)).rows[0];
  ok("01:00 IST casts to the PREVIOUS day under a UTC session (the bug class)",
    drift.utc_day === "2026-07-24", `${drift.utc_day} (session tz ${drift.tz})`);
  ok("util.ist_date() puts the same instant on 2026-07-25",
    drift.ist_day === "2026-07-25", drift.ist_day);

  const stragglers = (await c.query(`
    SELECT n.nspname||'.'||p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app','util','audit','analytics','secure')
       AND p.prokind = 'f'
       AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname='c')
       AND pg_get_functiondef(p.oid) ~* '\\mCURRENT_DATE\\M'
       AND NOT (COALESCE(p.proconfig,'{}') @> ARRAY['TimeZone=Asia/Kolkata'])
     ORDER BY 1`)).rows.map((r) => r.fn);
  ok("no deployed function still buckets a business day on a UTC CURRENT_DATE",
    stragglers.length === 0, stragglers.join(", ") || "none");

  // ───────────────────────────────────────────────────────────────────────────
  // PART C — the BOUNDARY, not the predicate (added by review of migration 160)
  //
  // Everything above Part C asks `app.has_cap()`, which is a lookup in
  // role_capabilities. That is not what refuses a request — RLS is. Part A can
  // therefore pass in full while an admin is still unable to perform an action
  // the matrix ticks for them, and that is exactly what was found. These probes
  // run as the `authenticated` ROLE so policies actually engage (as `postgres`
  // the harness is the table owner and RLS is bypassed, which is why no earlier
  // assertion could have caught this).
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- PART C: what a plain admin can actually DO (RLS engaged) ---");

  const asAdmin = async (sqlText, params = []) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('app.actor_id', $1, true)`, [hr]);
      await c.query(`SELECT set_config('app.reason', $1, true)`,
        ["proof harness: exercising the row-level boundary for a plain admin"]);
      await c.query(`SELECT set_config('app.source', 'web_admin', true)`);
      await c.query("SET LOCAL ROLE authenticated");
      const r = await c.query(sqlText, params);
      await c.query("ROLLBACK");
      return { ok: true, rowCount: r.rowCount, rows: r.rows };
    } catch (err) {
      await c.query("ROLLBACK");
      return { ok: false, code: err.code, message: err.message };
    }
  };

  // Sanity: the probe harness really is acting as the admin under RLS.
  const whoami = await asAdmin(
    `SELECT current_user AS who, app.is_admin() AS is_admin, app.is_super_admin() AS is_super`);
  ok("the RLS probe runs as `authenticated` and resolves to a plain admin",
    whoami.ok && whoami.rows[0].who === "authenticated"
      && whoami.rows[0].is_admin === true && whoami.rows[0].is_super === false,
    whoami.ok ? JSON.stringify(whoami.rows[0]) : `${whoami.code} ${whoami.message}`);

  // `attendance.lock.manage` is an ADMIN capability. What can an admin do?
  const softLock = await asAdmin(`
    INSERT INTO public.attendance_locks
      (company_id, scope, from_date, to_date, lock_kind, reason, locked_by)
    SELECT co.id, 'company', DATE '2026-06-01', DATE '2026-06-30', 'soft',
           'harness: soft lock is the admin half of attendance.lock.manage', $1
      FROM public.companies co ORDER BY co.created_at LIMIT 1
    RETURNING id`, [hr]);
  ok("admin CAN take a SOFT attendance lock (attendance_locks__admin_insert)",
    softLock.ok && softLock.rowCount === 1,
    softLock.ok ? "inserted" : `${softLock.code} ${softLock.message}`);

  const hardLock = await asAdmin(`
    INSERT INTO public.attendance_locks
      (company_id, scope, from_date, to_date, lock_kind, reason, locked_by)
    SELECT co.id, 'company', DATE '2026-05-01', DATE '2026-05-31', 'hard',
           'harness: a hard lock must be refused for a plain admin', $1
      FROM public.companies co ORDER BY co.created_at LIMIT 1
    RETURNING id`, [hr]);
  ok("admin CANNOT take a HARD attendance lock — RLS refuses (42501)",
    !hardLock.ok && hardLock.code === "42501",
    hardLock.ok ? "INSERTED — the policy no longer restricts lock_kind" : String(hardLock.code));

  // The unlock. This is the one the capability description used to promise.
  // An UPDATE filtered out by a policy's USING clause is not an error — it
  // silently matches zero rows, which is why nothing surfaced this.
  const adminUpdatePolicies = (await c.query(`
    SELECT policyname, qual FROM pg_policies
     WHERE schemaname='public' AND tablename='attendance_locks'
       AND cmd IN ('UPDATE','ALL')`)).rows;
  ok("no policy on attendance_locks lets a non-super admin UPDATE (i.e. unlock)",
    adminUpdatePolicies.every((p) => /is_super_admin/.test(p.qual ?? "")),
    adminUpdatePolicies.map((p) => p.policyname).join(", ") || "no UPDATE policy at all");

  const unlockAttempt = await asAdmin(`
    WITH ins AS (
      INSERT INTO public.attendance_locks
        (company_id, scope, from_date, to_date, lock_kind, reason, locked_by)
      SELECT co.id, 'company', DATE '2026-04-01', DATE '2026-04-30', 'soft',
             'harness: take a lock, then try to release it as a plain admin', $1
        FROM public.companies co ORDER BY co.created_at LIMIT 1
      RETURNING id)
    UPDATE public.attendance_locks a
       SET unlocked_at = now(), unlocked_by = $1,
           unlock_reason = 'harness: release attempt by a plain admin'
     WHERE a.id IN (SELECT id FROM ins)
    RETURNING a.id`, [hr]);
  ok("admin CANNOT release a lock it just took — the UPDATE matches zero rows",
    unlockAttempt.ok && unlockAttempt.rowCount === 0,
    unlockAttempt.ok ? `rowCount=${unlockAttempt.rowCount}` : `${unlockAttempt.code} ${unlockAttempt.message}`);

  // `kiosk.device.manage` is an ADMIN capability; kiosk_devices is admin-READ.
  const deviceInsert = await asAdmin(`
    INSERT INTO public.kiosk_devices (device_code, label, location_id)
    SELECT 'HARNESS-PROBE-1', 'harness probe', l.id
      FROM public.locations l ORDER BY l.created_at LIMIT 1
    RETURNING id`);
  ok("admin CANNOT write kiosk_devices despite holding kiosk.device.manage (42501)",
    !deviceInsert.ok && deviceInsert.code === "42501",
    deviceInsert.ok ? "INSERTED — kiosk_devices is no longer super-admin write" : String(deviceInsert.code));

  const operatorWrite = await asAdmin(`
    SELECT count(*)::int n FROM pg_policies
     WHERE schemaname='public' AND tablename='kiosk_operators'
       AND cmd='ALL' AND qual ~ 'is_admin'`);
  ok("…but admin CAN manage kiosk_operators, so the capability is half-usable",
    operatorWrite.ok && operatorWrite.rows[0].n >= 1,
    operatorWrite.ok ? `${operatorWrite.rows[0].n} admin policy` : String(operatorWrite.code));

  // Both descriptions must now say what RLS enforces (migration 170).
  const descriptions = (await c.query(`
    SELECT capability, description FROM public.role_capabilities
     WHERE role='admin' AND capability IN ('attendance.lock.manage','kiosk.device.manage')
     ORDER BY 1`)).rows;
  for (const r of descriptions) {
    ok(`role_capabilities.description for ${r.capability} names its super_admin narrowing`,
      /super_admin/.test(r.description ?? ""), r.description ?? "NULL");
  }

  // The timezone leak migration 160 did not consider: a `SET timezone` on a
  // calling function is inherited by any trigger function that does not set its
  // own, and to_jsonb() renders timestamptz in the ambient zone.
  const auditCfg = (await c.query(`
    SELECT COALESCE(p.proconfig,'{}') cfg FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='audit' AND p.proname='log_changes'`)).rows[0].cfg;
  ok("audit.log_changes is pinned to UTC, so a caller's timezone cannot reach the field diff",
    auditCfg.some((s) => /^TimeZone=UTC$/i.test(s)), auditCfg.join(" "));
} catch (e) {
  console.error("HARNESS ERROR", e.message, e.detail ?? "");
  bad++;
} finally {
  await c.end().catch(() => {});
  await server.stop().catch(() => {});
  if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
}
console.log(bad === 0 ? "\nALL ASSERTIONS PASSED" : `\n${bad} ASSERTION(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
