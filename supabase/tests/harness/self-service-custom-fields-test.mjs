#!/usr/bin/env node
/**
 * FUNCTIONAL test of migration 20260801014000 — the two self-service WRITE paths
 * behind /me/profile/custom and /me/profile/documents. Run against a real
 * Postgres with every migration applied, AS THE `authenticated` ROLE, because
 * these are RLS policies and the table owner bypasses RLS: a test that runs as
 * `postgres` proves nothing about a policy.
 *
 * Proves:
 *   1. `authenticated` holds the table privileges the policies need, and still
 *      holds no DELETE.
 *   2. An employee CAN insert then update their own value for a def that is
 *      is_employee_editable with requires_approval = false.
 *   3. An employee CANNOT touch a def that is not is_employee_editable
 *      (LOCKER_NUMBER) nor one that requires_approval (BLOOD_GROUP) — those
 *      travel as change requests.
 *   4. An employee CANNOT write another employee's value.
 *   5. `trg_ecfv__validate` still owns value correctness: an off-list
 *      single_select value and a below-minimum number are refused (23514).
 *   6. The change-request path works for the requires_approval def, and the
 *      `custom:<CODE>` convention is mandatory (22023 otherwise).
 *   7. An employee CAN file a document as pending_review, and read it back.
 *   8. The document row cannot be forged: status='approved', another employee's
 *      record, an e-signed type, or a requires_expiry type with no expiry are
 *      each refused.
 *
 * Usage: PGPORT_TEST=54381 node self-service-custom-fields-test.mjs
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const PORT = Number(process.env.PGPORT_TEST ?? 54381);
const DATA = join(process.env.TMPDIR ?? "/tmp", `pgdata-selfservice-${PORT}`);

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
await server.createDatabase("selfservice");
const db = new pg.Client({
  host: "localhost", port: PORT, user: "postgres", password: "postgres", database: "selfservice",
});
await db.connect();

/** Run `sql` exactly as PostgREST would: one transaction, role authenticated. */
async function asEmployee(actor, sql, params = []) {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('app.actor_id', $1::text, true)`, [actor]);
    await db.query("SET LOCAL ROLE authenticated");
    const r = await db.query(sql, params);
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

const refusal = (fn) => fn().then(() => null, (e) => `${e.code ?? "?"}: ${e.message}`);

try {
  await db.query(readFileSync(join(HERE, "supabase-shim.sql"), "utf8"));
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try { await db.query(readFileSync(join(MIGRATIONS, f), "utf8")); }
    catch (e) { console.log(`SETUP FAIL ${f}: ${e.message}`); process.exit(1); }
  }
  console.log("migrations applied\n");

  // ---- actors ---------------------------------------------------------------
  // The FIRST auth user is bootstrapped to super_admin (migration 004), so burn
  // one, then make two ordinary employees.
  await db.query(`INSERT INTO auth.users (email, raw_user_meta_data)
                  VALUES ('bootstrap@tamarindtree.co','{"full_name":"Bootstrap"}'::jsonb)`);
  const mkUser = async (email, name) =>
    (await db.query(`INSERT INTO auth.users (email, raw_user_meta_data)
      VALUES ($1, jsonb_build_object('full_name', $2::text)) RETURNING id`, [email, name])).rows[0].id;
  const meAuth = await mkUser("asha@tamarindtree.co", "Asha Rao");
  const otherAuth = await mkUser("vikram@tamarindtree.co", "Vikram Shetty");

  const mkEmployee = async (profileId, first, last, mobile) =>
    (await db.query(`
      INSERT INTO public.employees
        (company_id, first_name, last_name, display_name, employment_type,
         employment_status, date_of_join, department_id, designation_id, location_id,
         shift_id, attendance_policy_id, weekly_off_rule_id, holiday_calendar_id,
         punch_mode, profile_id, mobile, blood_group)
      SELECT (SELECT id FROM public.companies WHERE code='TT'),
             $2,$3,$2 || ' ' || $3,'permanent','active', DATE '2026-01-01',
             (SELECT id FROM public.departments WHERE code='BANQ'),
             (SELECT id FROM public.designations WHERE code='STEWARD'),
             (SELECT id FROM public.locations WHERE code='TTT-VENUE'),
             (SELECT id FROM public.shifts WHERE code='G'),
             (SELECT id FROM public.attendance_policies WHERE code='AP-OPS'),
             (SELECT id FROM public.weekly_off_rules WHERE code='WO-MIDWEEK-TUE'),
             (SELECT id FROM public.holiday_calendars LIMIT 1),
             'multi_punch', $1, $4, 'unknown'
      RETURNING id, employee_code, company_id`, [profileId, first, last, mobile])).rows[0];

  const me = await mkEmployee(meAuth, "Asha", "Rao", "9880011224");
  const other = await mkEmployee(otherAuth, "Vikram", "Shetty", "9880011225");
  console.log(`employees ${me.employee_code} / ${other.employee_code} created\n`);

  // ---- the four venue defs this test needs ----------------------------------
  // settings.seed_demo_data is false by default, so migration 060's eight venue
  // fields are absent here. These four mirror its shapes EXACTLY, including the
  // [{value,label}] option objects trg_ecfv__validate reads via o->>'value'.
  const mkDef = async (code, label, type, opts) =>
    (await db.query(`
      INSERT INTO public.employee_custom_field_defs
        (company_id, code, label, field_type, options, is_required,
         is_employee_editable, requires_approval, is_pii, section, sort_order,
         min_value, max_value)
      SELECT (SELECT id FROM public.companies WHERE code='TT'),
             $1,$2,$3::public.custom_field_type,$4::jsonb,false,$5,$6,$7,$8,$9,$10,$11
      RETURNING id`, [
      code, label, type, opts.options ?? null, opts.editable, opts.approval,
      opts.pii ?? false, opts.section ?? "additional", opts.sort ?? 10,
      opts.min ?? null, opts.max ?? null,
    ])).rows[0].id;

  const uniform = await mkDef("UNIFORM_SIZE", "Uniform size", "single_select", {
    editable: true, approval: false,
    options: '[{"value":"S","label":"S"},{"value":"M","label":"M"},{"value":"L","label":"L"}]',
  });
  const shoe = await mkDef("SHOE_SIZE", "Safety shoe size (UK)", "number", {
    editable: true, approval: false, min: 4, max: 13,
  });
  const blood = await mkDef("BLOOD_GROUP", "Blood group", "single_select", {
    editable: true, approval: true, pii: true, section: "medical",
    options: '[{"value":"O+","label":"O+"},{"value":"B+","label":"B+"}]',
  });
  const locker = await mkDef("LOCKER_NUMBER", "Locker number", "text", {
    editable: false, approval: true, section: "logistics",
  });

  // ---- 1. privileges --------------------------------------------------------
  console.log("1. The grants the policies rely on");
  const priv = await db.query(`
    SELECT has_table_privilege('authenticated','public.employee_custom_field_values','INSERT') AS ecfv_ins,
           has_table_privilege('authenticated','public.employee_custom_field_values','UPDATE') AS ecfv_upd,
           has_table_privilege('authenticated','public.employee_custom_field_values','DELETE') AS ecfv_del,
           has_table_privilege('authenticated','public.documents','INSERT') AS doc_ins,
           has_table_privilege('authenticated','public.documents','DELETE') AS doc_del,
           has_function_privilege('authenticated','app.custom_field_is_self_writable(uuid)','EXECUTE') AS fn1,
           has_function_privilege('authenticated','app.current_employee_company_id()','EXECUTE') AS fn2`);
  const p = priv.rows[0];
  check("authenticated may INSERT employee_custom_field_values", p.ecfv_ins === true);
  check("authenticated may UPDATE employee_custom_field_values", p.ecfv_upd === true);
  check("authenticated may NOT DELETE employee_custom_field_values", p.ecfv_del === false);
  check("authenticated may INSERT documents", p.doc_ins === true);
  check("authenticated may NOT DELETE documents", p.doc_del === false);
  check("authenticated may execute app.custom_field_is_self_writable", p.fn1 === true);
  check("authenticated may execute app.current_employee_company_id", p.fn2 === true);

  // ---- 2. the direct write --------------------------------------------------
  console.log("\n2. requires_approval = false ⇒ the employee writes it directly");
  const insertValue = (actor, employeeId, defId, cols) => asEmployee(actor, `
    INSERT INTO public.employee_custom_field_values
      (employee_id, field_def_id, value_text, value_number, value_date, value_boolean,
       value_json, value_document_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id, value_text, value_number`,
    [employeeId, defId, cols.text ?? null, cols.number ?? null, cols.date ?? null,
     cols.bool ?? null, cols.json ?? null, cols.doc ?? null]);

  const inserted = await insertValue(meAuth, me.id, uniform, { text: "M" });
  check("own UNIFORM_SIZE insert accepted", inserted.rows[0].value_text === "M");

  const updated = await asEmployee(meAuth, `
    UPDATE public.employee_custom_field_values
       SET value_text = 'L', value_number = NULL, value_date = NULL,
           value_boolean = NULL, value_json = NULL, value_document_id = NULL
     WHERE id = $1 RETURNING value_text`, [inserted.rows[0].id]);
  check("own UNIFORM_SIZE update accepted", updated.rows[0]?.value_text === "L");

  const shoeOk = await insertValue(meAuth, me.id, shoe, { number: 9 });
  check("own SHOE_SIZE (number) insert accepted", Number(shoeOk.rows[0].value_number) === 9);

  // ---- 3. the two defs an employee may NOT write ----------------------------
  console.log("\n3. Not employee-editable, or approval-gated ⇒ refused by RLS");
  const lockerRefused = await refusal(() => insertValue(meAuth, me.id, locker, { text: "L-14" }));
  check("LOCKER_NUMBER (is_employee_editable=false) refused",
    (lockerRefused ?? "").includes("42501"), lockerRefused ?? "accepted!");
  const bloodRefused = await refusal(() => insertValue(meAuth, me.id, blood, { text: "O+" }));
  check("BLOOD_GROUP (requires_approval=true) refused",
    (bloodRefused ?? "").includes("42501"), bloodRefused ?? "accepted!");

  // ---- 4. someone else's record --------------------------------------------
  console.log("\n4. Another employee's value is not mine to write");
  const otherRefused = await refusal(() => insertValue(meAuth, other.id, uniform, { text: "S" }));
  check("writing another employee's UNIFORM_SIZE refused",
    (otherRefused ?? "").includes("42501"), otherRefused ?? "accepted!");

  // ---- 5. the trigger still owns the VALUE ---------------------------------
  console.log("\n5. trg_ecfv__validate remains the authority on the value");
  await db.query(`DELETE FROM public.employee_custom_field_values
                   WHERE employee_id=$1 AND field_def_id=$2`, [me.id, uniform]);
  const badOption = await refusal(() => insertValue(meAuth, me.id, uniform, { text: "XXXL" }));
  check("off-list single_select value refused (23514)",
    (badOption ?? "").includes("23514") && (badOption ?? "").includes("not one of the configured options"),
    badOption ?? "accepted!");
  const wrongColumn = await refusal(() => insertValue(meAuth, me.id, uniform, { number: 4 }));
  check("value in the wrong typed column refused (23514)",
    (wrongColumn ?? "").includes("23514"), wrongColumn ?? "accepted!");
  await db.query(`DELETE FROM public.employee_custom_field_values
                   WHERE employee_id=$1 AND field_def_id=$2`, [me.id, shoe]);
  const belowMin = await refusal(() => insertValue(meAuth, me.id, shoe, { number: 2 }));
  check("number below min_value refused (23514)",
    (belowMin ?? "").includes("23514"), belowMin ?? "accepted!");

  // ---- 6. the change-request path for the approval-gated def ----------------
  console.log("\n6. requires_approval = true ⇒ employee_change_requests");
  const crOk = await asEmployee(meAuth, `
    INSERT INTO public.employee_change_requests
      (employee_id, requested_by, entity_table, field_name, field_label,
       old_value, new_value, is_sensitive)
    VALUES ($1,$2,'employee_custom_field_values','custom:BLOOD_GROUP','Blood group',
            NULL,'"O+"'::jsonb,true) RETURNING id, status`, [me.id, meAuth]);
  check("custom:BLOOD_GROUP change request accepted", crOk.rows[0]?.status === "pending");

  const badConvention = await refusal(() => asEmployee(meAuth, `
    INSERT INTO public.employee_change_requests
      (employee_id, requested_by, entity_table, field_name, field_label, new_value)
    VALUES ($1,$2,'employee_custom_field_values','BLOOD_GROUP','Blood group','"O+"'::jsonb)`,
    [me.id, meAuth]));
  check("field_name without the custom: prefix refused (22023)",
    (badConvention ?? "").includes("22023"), badConvention ?? "accepted!");

  const notEditable = await refusal(() => asEmployee(meAuth, `
    INSERT INTO public.employee_change_requests
      (employee_id, requested_by, entity_table, field_name, field_label, new_value)
    VALUES ($1,$2,'employee_custom_field_values','custom:LOCKER_NUMBER','Locker number','"L-14"'::jsonb)`,
    [me.id, meAuth]));
  check("change request for a non-editable def refused (42501)",
    (notEditable ?? "").includes("42501"), notEditable ?? "accepted!");

  // Approving it writes the value through apply_change_request — proving the
  // maker-checker half lands in the same typed column the direct path uses.
  await db.query(`UPDATE public.employee_change_requests
                     SET status='approved', decided_by=$2, decided_at=now()
                   WHERE id=$1`, [crOk.rows[0].id, meAuth]);
  await db.query(`SELECT public.apply_change_request($1)`, [crOk.rows[0].id]);
  const applied = await db.query(`
    SELECT v.value_text, r.status, r.apply_error
      FROM public.employee_change_requests r
      LEFT JOIN public.employee_custom_field_values v
        ON v.employee_id = r.employee_id AND v.field_def_id = $2
     WHERE r.id = $1`, [crOk.rows[0].id, blood]);
  check("approved custom-field request applies into value_text",
    applied.rows[0]?.status === "applied" && applied.rows[0]?.value_text === "O+",
    JSON.stringify(applied.rows[0]));

  // ---- 7. filing a document ------------------------------------------------
  console.log("\n7. An employee files a document as pending_review");
  const typeOf = async (code) =>
    (await db.query(`SELECT id, code, requires_expiry FROM public.document_types WHERE code=$1`, [code])).rows[0];
  const eduCert = await typeOf("EDU_CERT");        // employee-visible, no esign, no expiry
  const contract = await typeOf("CONTRACT");       // requires_esign = true
  const medical = await typeOf("MEDICAL_CERT");    // requires_expiry = true

  const insertDoc = (actor, o) => asEmployee(actor, `
    INSERT INTO public.documents
      (document_type_id, company_id, subject_kind, employee_id, title, file_name,
       storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
       current_version, status, virus_scan_status, is_system_generated,
       is_confidential, requires_acknowledgement, uploaded_by, expiry_date, tags)
    VALUES ($1,$2,'employee',$3,$4,'scan.pdf','documents',$5,'application/pdf',
            120345,$6,1,$7,'pending',false,false,false,$8,$9,ARRAY['employee-upload'])
    RETURNING id, status`,
    [o.typeId, o.companyId, o.employeeId, o.title,
     `employee/${o.employeeId}/${o.typeCode}/${o.title.replace(/\W+/g, "-")}.pdf`,
     "a".repeat(64), o.status ?? "pending_review", o.uploadedBy, o.expiry ?? null]);

  const docOk = await insertDoc(meAuth, {
    typeId: eduCert.id, typeCode: eduCert.code, companyId: me.company_id,
    employeeId: me.id, title: "Degree certificate", uploadedBy: meAuth,
  });
  check("own EDU_CERT upload accepted as pending_review",
    docOk.rows[0]?.status === "pending_review", JSON.stringify(docOk.rows[0]));

  const readBack = await asEmployee(meAuth,
    `SELECT id, status FROM public.documents WHERE id = $1`, [docOk.rows[0].id]);
  check("the employee can read their own new document back",
    readBack.rows.length === 1, `${readBack.rows.length} row(s)`);

  // ---- 8. what cannot be forged --------------------------------------------
  console.log("\n8. The row an employee may create is exactly one shape");
  const approvedRefused = await refusal(() => insertDoc(meAuth, {
    typeId: eduCert.id, typeCode: eduCert.code, companyId: me.company_id,
    employeeId: me.id, title: "Self-approved cert", uploadedBy: meAuth, status: "approved",
  }));
  check("status='approved' refused (42501)",
    (approvedRefused ?? "").includes("42501"), approvedRefused ?? "accepted!");

  const otherDocRefused = await refusal(() => insertDoc(meAuth, {
    typeId: eduCert.id, typeCode: eduCert.code, companyId: other.company_id,
    employeeId: other.id, title: "Not mine", uploadedBy: meAuth,
  }));
  check("a document on another employee's record refused (42501)",
    (otherDocRefused ?? "").includes("42501"), otherDocRefused ?? "accepted!");

  const esignRefused = await refusal(() => insertDoc(meAuth, {
    typeId: contract.id, typeCode: contract.code, companyId: me.company_id,
    employeeId: me.id, title: "My own contract", uploadedBy: meAuth,
  }));
  check("a requires_esign type refused (42501)",
    (esignRefused ?? "").includes("42501"), esignRefused ?? "accepted!");

  const noExpiryRefused = await refusal(() => insertDoc(meAuth, {
    typeId: medical.id, typeCode: medical.code, companyId: me.company_id,
    employeeId: me.id, title: "Food handler fitness", uploadedBy: meAuth,
  }));
  check("a requires_expiry type with no expiry_date refused (42501)",
    (noExpiryRefused ?? "").includes("42501"), noExpiryRefused ?? "accepted!");

  const withExpiry = await insertDoc(meAuth, {
    typeId: medical.id, typeCode: medical.code, companyId: me.company_id,
    employeeId: me.id, title: "Food handler fitness", uploadedBy: meAuth,
    expiry: "2027-06-30",
  });
  check("the same type WITH an expiry_date accepted",
    withExpiry.rows[0]?.status === "pending_review", JSON.stringify(withExpiry.rows[0]));

  const wrongUploader = await refusal(() => insertDoc(meAuth, {
    typeId: eduCert.id, typeCode: eduCert.code, companyId: me.company_id,
    employeeId: me.id, title: "Attributed to someone else", uploadedBy: otherAuth,
  }));
  check("uploaded_by pointing at another profile refused (42501)",
    (wrongUploader ?? "").includes("42501"), wrongUploader ?? "accepted!");

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await db.end().catch(() => {});
  await server.stop().catch(() => {});
}
process.exit(fail === 0 ? 0 : 1);
