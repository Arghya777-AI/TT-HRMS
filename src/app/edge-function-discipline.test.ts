/**
 * edge-function-discipline.test.ts — enforce the banned patterns in
 * `supabase/functions/**`, which ESLINT NEVER SEES.
 *
 * WHY A TEST AND NOT AN ESLINT RULE
 * --------------------------------
 * `eslint.config.js` scopes every TypeScript block to `files: ["src/**"]`, so all
 * 33 edge functions are unlinted: no-explicit-any, the IST restrictions and the
 * rest are simply not applied there. An adversarial review flagged it.
 *
 * Extending ESLint to cover them is not a small change — they are Deno, they
 * import via `npm:` specifiers, and pointing the browser parser at them produces
 * dozens of parse errors rather than findings (I did exactly that by accident
 * once and got 43). A grep-shaped test enforces the same rules today, with no
 * parser to fight, and runs in the suite everyone already runs.
 *
 * WHAT IT DEFENDS, and why each one matters here
 * ---------------------------------------------
 *   * `toISOString()` / bare `new Date()` / `Date.now()` / `getUTC*` — this
 *     product's business day is IST. A UTC day boundary silently moves a punch to
 *     the wrong date for 5½ hours out of every 24, which is a payroll error that
 *     nobody notices until month end. `_shared/datetime.ts` is the sanctioned way.
 *   * `: any` — an edge function is the trust boundary; `any` there erases the
 *     checking that makes a validated request meaningful.
 *   * `@ts-ignore` / `eslint-disable` — both were explicitly forbidden for this
 *     work, and both are how a rule quietly stops applying.
 *
 * COMMENTS ARE STRIPPED FIRST. Three files legitimately contain the word "any" in
 * prose ("any template marked…", "any 5xx enqueues locally"), and flagging those
 * would train everyone to ignore this test — which is worse than not having it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "supabase/functions");

/** The one module allowed to touch raw date primitives — it IS the helper. */
const DATETIME_HELPER = "_shared/datetime.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Remove comments and string literals before matching.
 *
 * Without this the test fires on prose and on the problem+json `detail` strings
 * that legitimately mention dates. Crude but deliberately so: it only has to be
 * good enough that a real occurrence in CODE is still visible.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const FILES = walk(ROOT).map((path) => ({
  path,
  rel: path.slice(ROOT.length + 1),
  code: stripCommentsAndStrings(readFileSync(path, "utf8")),
}));

/** Find every file whose CODE matches, excluding the sanctioned helper. */
function offenders(pattern: RegExp, allow: readonly string[] = []): string[] {
  return FILES.filter(
    (f) => !allow.includes(f.rel) && pattern.test(f.code),
  ).map((f) => f.rel);
}

describe("edge function discipline (eslint does not cover supabase/functions)", () => {
  it("finds the functions at all — a silent zero would pass every rule below", () => {
    expect(FILES.length).toBeGreaterThan(25);
  });

  it("uses no toISOString() outside the datetime helper", () => {
    expect(offenders(/\.toISOString\s*\(/, [DATETIME_HELPER])).toEqual([]);
  });

  it("constructs no bare new Date() outside the datetime helper", () => {
    // `new Date(someValue)` is fine — parsing a given instant. `new Date()` reads
    // the wall clock, which is what must go through the helper.
    expect(offenders(/new\s+Date\s*\(\s*\)/, [DATETIME_HELPER])).toEqual([]);
  });

  it("calls no Date.now() outside the datetime helper", () => {
    expect(offenders(/\bDate\s*\.\s*now\s*\(/, [DATETIME_HELPER])).toEqual([]);
  });

  it("reads no UTC component accessors outside the datetime helper", () => {
    expect(offenders(/\.getUTC[A-Za-z]+\s*\(/, [DATETIME_HELPER])).toEqual([]);
  });

  it("formats no DATE through toLocaleDateString", () => {
    // `toLocaleString` on a NUMBER is allowed and used once, for lakh/crore money
    // grouping in the AI digest. Dates are the hazard, so only the date variant
    // is banned.
    expect(offenders(/\.toLocaleDateString\s*\(/)).toEqual([]);
  });

  it("declares no `any`", () => {
    expect(offenders(/:\s*any\b/)).toEqual([]);
    expect(offenders(/\bas\s+any\b/)).toEqual([]);
  });

  it("suppresses no type errors", () => {
    expect(offenders(/@ts-(ignore|expect-error|nocheck)/)).toEqual([]);
  });

  it("disables no lint rules", () => {
    expect(offenders(/eslint-disable/)).toEqual([]);
  });

  it("declares ALLOWED_METHODS as an ARRAY, never a string", () => {
    /*
      `handlePreflight(req, allowedMethods: readonly string[])` and
      `methodNotAllowed` both JOIN this value. `kiosk-provision` declared it as
      `"POST, OPTIONS"` — a string — so every OPTIONS preflight threw and answered
      500, and the browser then blocked the POST it was asking permission for.
      `curl` never preflights, so every server-side test of that endpoint passed
      while the admin console could not save anything at all.

      TypeScript would have caught it in a heartbeat; nothing typechecks
      supabase/functions (tsconfig.app.json scopes `include` to `src`), which is
      exactly why this belongs in a test.
    */
    const wrong = FILES.filter((f) =>
      /const\s+ALLOWED_METHODS\s*=\s*["'`]/.test(f.code),
    ).map((f) => f.rel);
    expect(wrong).toEqual([]);
  });

  it("puts no backtick in a SQL line comment", () => {
    /*
      Every query in these functions is a TAGGED TEMPLATE LITERAL, so a backtick
      inside it ends the SQL string mid-statement. A `--` comment is where this
      happens, because prose is where anyone reaches for backticks to quote a
      column name:

          const rows = await client`
            SELECT d.id,
                   -- the device's own `allowed_geofence` wins   <-- ENDS THE STRING
                   COALESCE(...)

      The parse error lands on the NEXT interpolation and reads
      "SyntaxError: Expression expected", pointing at a line that is perfectly
      fine — and the function then fails to load at all, so every request to it
      500s. I wrote exactly this while adding the geofence to `verifyDevice`, which
      would have taken kiosk authentication down completely.

      `tsc` never sees these files (tsconfig.app.json scopes `include` to `src`), so
      nothing else catches it before deploy.

      NOTE: matched on the RAW source, not the comment-stripped copy the other rules
      use — the thing being detected IS a comment.
    */
    const offenders: string[] = [];
    for (const file of FILES) {
      const raw = readFileSync(file.path, "utf8");
      const lines = raw.split("\n");
      lines.forEach((line, i) => {
        if (/^\s*--/.test(line) && line.includes("`")) {
          offenders.push(`${file.rel}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("passes ALLOWED_METHODS to handlePreflight wherever it handles requests", () => {
    // A function that serves traffic but never preflights is unreachable from a
    // browser for a different reason: no Access-Control-Allow-Origin on OPTIONS.
    const serving = FILES.filter((f) => /Deno\.serve\s*\(/.test(f.code));
    const missing = serving
      .filter((f) => !/handlePreflight\s*\(/.test(f.code))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });
});
