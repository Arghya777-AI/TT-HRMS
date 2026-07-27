#!/usr/bin/env node
/**
 * Full-reset validation of HRMS migrations against embedded PostgreSQL 17.
 * Usage: node validate.mjs [--continue]  (default: stop at first failing file)
 * Exit 0 = all clean. Prints per-file result + post-flight RLS audit.
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, `pgdata-${process.env.PGPORT_TEST ?? "54329"}`);
const MIGRATIONS = join(HERE, "..", "..", "migrations");
const SHIM = join(HERE, "supabase-shim.sql");
const PORT = Number(process.env.PGPORT_TEST ?? 54329);
const CONTINUE = process.argv.includes("--continue");

function lineOf(sql, position) {
  if (!position) return null;
  return sql.slice(0, Number(position)).split("\n").length;
}

/**
 * Dollar-quote / string / comment aware statement splitter. Returns
 * [{sql, line}] so a failing statement can be reported with its file line.
 * NOTE: a plpgsql error's `position` is relative to the FUNCTION BODY, not the
 * file — which is why whole-file line numbers mislead. Splitting first and
 * reporting the statement's own start line is the reliable signal.
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  let startIdx = 0;
  let tag = null;
  let inLine = false;
  let inStr = false;
  const lineAt = (idx) => sql.slice(0, idx).split("\n").length;
  while (i < sql.length) {
    const ch = sql[i];
    if (inLine) { buf += ch; if (ch === "\n") inLine = false; i++; continue; }
    if (tag) {
      if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; tag = null; continue; }
      buf += ch; i++; continue;
    }
    if (inStr) { buf += ch; if (ch === "'") inStr = false; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { inLine = true; buf += ch; i++; continue; }
    if (ch === "'") { inStr = true; buf += ch; i++; continue; }
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; buf += m[0]; i += m[0].length; continue; }
    }
    if (ch === ";") {
      if (buf.trim()) out.push({ sql: buf + ";", line: lineAt(startIdx) });
      buf = ""; i++; startIdx = i; continue;
    }
    buf += ch; i++;
  }
  if (buf.trim()) out.push({ sql: buf, line: lineAt(startIdx), unterminated: true });
  // Drop comment-only statements. The obvious regex for this,
  // /^\s*(--[^\n]*\n?)*\s*;?\s*$/, has nested quantifiers: on a NON-matching
  // input (a long comment header followed by real SQL) the engine backtracks
  // through every way of splitting each newline between `\n?` and `\s*` —
  // 2^lines paths. Migration 052's ~50-line header turned validation into ~40
  // CPU-minutes of proving one regex non-match. Strip-then-test is linear.
  return out.filter((s) => s.sql.replace(/--[^\n]*/g, "").replace(/[\s;]+/g, "") !== "");
}

/** Re-run a failed file statement-by-statement to pinpoint the bad statement. */
async function pinpoint(client, sql) {
  await client.query("BEGIN").catch(() => {});
  const stmts = splitStatements(sql);
  for (const st of stmts) {
    if (st.unterminated) {
      console.log(`      >> UNTERMINATED statement starting at line ${st.line}`);
      break;
    }
    try {
      await client.query(st.sql);
    } catch (e) {
      console.log(`      >> failing statement starts at line ${st.line}: ${e.message}`);
      const body = st.sql.trim().split("\n");
      console.log(`      >> head: ${body.slice(0, 2).join(" / ")}`);
      if (body.length > 4) console.log(`      >> tail: ${body.slice(-3).join(" / ")}`);
      break;
    }
  }
  await client.query("ROLLBACK").catch(() => {});
}

// fresh cluster every run — cheap (~2s) and hermetic
if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const server = new EmbeddedPostgres({
  databaseDir: DATA,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: false,
});
await server.initialise();
await server.start();
await server.createDatabase("hrms_validate");

const client = new pg.Client({
  host: "localhost",
  port: PORT,
  user: "postgres",
  password: "postgres",
  database: "hrms_validate",
});
await client.connect();

let failures = 0;
try {
  await client.query(readFileSync(SHIM, "utf8"));
  console.log("shim ok");

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  console.log(`${files.length} migration files`);

  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    try {
      await client.query(sql);
      console.log(`ok    ${f}`);
    } catch (e) {
      failures++;
      await client.query("ROLLBACK").catch(() => {});
      console.log(`FAIL  ${f}`);
      console.log(`      ${e.message}${e.position ? ` (line ~${lineOf(sql, e.position)})` : ""}`);
      if (e.detail) console.log(`      DETAIL: ${e.detail}`);
      if (e.hint) console.log(`      HINT: ${e.hint}`);
      if (e.where) console.log(`      WHERE: ${String(e.where).slice(0, 300)}`);
      await pinpoint(client, sql);
      if (!CONTINUE) break;
    }
  }

  if (failures === 0) {
    const rls = await client.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
      ORDER BY 1`);
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')) AS public_tables,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='secure' AND c.relkind IN ('r','p')) AS secure_tables,
        (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('app','util','audit')) AS helper_fns,
        (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public') AS triggers,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v') AS views`);
    console.log("ALL MIGRATIONS APPLIED CLEAN");
    console.log("stats:", JSON.stringify(counts.rows[0]));
    if (rls.rows.length) {
      console.log("RLS-OFF TABLES (must be zero):", rls.rows.map((r) => r.relname).join(", "));
    } else {
      console.log("RLS enabled on every public table ✓");
    }
  }
} finally {
  await client.end().catch(() => {});
  await server.stop().catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
