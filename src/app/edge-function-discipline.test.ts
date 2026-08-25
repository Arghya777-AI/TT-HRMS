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
/**
 * Blank out comments and string literals, leaving CODE.
 *
 * ── WHY THIS IS A SCANNER AND NOT FIVE REGEXES ───────────────────────────────
 * It used to be five chained `replace` calls, and it was nearly blind. Every function here
 * carries `/* ... *\/` comments INSIDE its SQL template literals; stripping those first
 * removed text across backtick boundaries, so the following backtick regex paired up the wrong
 * delimiters and swallowed real code as though it were a string. Measured on the largest
 * function it kept 13% of the file — meaning 87% of `kiosk-punch` was exempt from every rule
 * below, and a `Date.now()` sat there passing.
 *
 * A guard that silently exempts most of what it guards is worse than no guard: it produces
 * confidence rather than coverage. So this walks the source once, tracking what it is inside,
 * which is the only way to get the nesting right — `${...}` inside a template contains real
 * code that must be kept, and may contain further templates.
 *
 * Everything is replaced with SPACES rather than removed, so reported positions stay honest.
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  /** Template nesting depth of `${}` we are currently inside, innermost last. */
  const templateStack: number[] = [];
  let i = 0;
  let braceDepth = 0;

  const keep = (n = 1) => {
    out.push(source.slice(i, i + n));
    i += n;
  };
  /**
   * The last non-space CODE character emitted, which is how a regex literal is told from a
   * division. `/` after a value divides; `/` after an operator, a comma or an opening bracket
   * begins a pattern. The standard heuristic, and sufficient here.
   *
   * It has to be handled at all because `log.ts` redacts with
   * `/\$argon2[a-z]{0,2}\$[^\s"]+/gi` — a pattern containing a double quote. Without this the
   * scanner read that quote as a string opener and swallowed the next eighteen declarations.
   */
  let lastCode = "";
  const REGEX_MAY_FOLLOW = new Set([
    "",
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "<",
    ">",
    "~",
    "^",
    "\n",
  ]);
  const blank = (n = 1) => {
    out.push(" ".repeat(n));
    i += n;
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    // Block comment.
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(stop - i);
      continue;
    }
    // Line comment. `[^:]` guard is gone: a scanner knows a `//` inside a string is a string.
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(stop - i);
      continue;
    }
    // Quoted strings: single, double.
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      blank(Math.min(j + 1, source.length) - i);
      continue;
    }
    // Template literal: blank its text, but KEEP the code inside `${ }`.
    if (source[i] === "`") {
      blank();
      let inTemplate = true;
      while (inTemplate && i < source.length) {
        if (source[i] === "\\") {
          blank(2);
          continue;
        }
        if (source[i] === "`") {
          blank();
          inTemplate = false;
          break;
        }
        if (source.slice(i, i + 2) === "${") {
          blank(2);
          templateStack.push(braceDepth);
          braceDepth += 1;
          // Fall back to the outer loop so the interpolation is scanned as code.
          inTemplate = false;
          break;
        }
        blank();
      }
      continue;
    }
    // Closing an interpolation returns us to template text.
    if (source[i] === "}" && templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]! + 1) {
      blank();
      braceDepth = templateStack.pop()!;
      // Resume the template we were inside.
      let inTemplate = true;
      while (inTemplate && i < source.length) {
        if (source[i] === "\\") {
          blank(2);
          continue;
        }
        if (source[i] === "`") {
          blank();
          inTemplate = false;
          break;
        }
        if (source.slice(i, i + 2) === "${") {
          blank(2);
          templateStack.push(braceDepth);
          braceDepth += 1;
          inTemplate = false;
          break;
        }
        blank();
      }
      continue;
    }
    // Regex literal: blank it, so quotes inside a pattern cannot open a phantom string.
    if (source[i] === "/" && REGEX_MAY_FOLLOW.has(lastCode)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const ch = source[j]!;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") break; // Unterminated: not a regex after all.
        if (inClass) {
          if (ch === "]") inClass = false;
        } else if (ch === "[") {
          inClass = true;
        } else if (ch === "/") {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        // Trailing flags.
        while (j < source.length && /[a-z]/.test(source[j]!)) j += 1;
        blank(j - i);
        lastCode = ")"; // A regex is a value, so a following `/` is division.
        continue;
      }
    }

    if (source[i] === "{") braceDepth += 1;
    else if (source[i] === "}" && braceDepth > 0) braceDepth -= 1;
    const ch = source[i]!;
    if (ch.trim() !== "") lastCode = ch;
    keep();
  }
  return out.join("");
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

  it("still SEES the code it is meant to be guarding", () => {
    /*
      The rule that catches this file going blind, which it once was.

      The stripping used to be chained regexes. Every function carries block comments inside its
      SQL template literals; removing those first shifted the backtick pairing, so real code was
      swallowed as string — on `kiosk-punch` only 13% of the file survived, meaning 87% of it was
      exempt from every rule below and a `Date.now()` sat there passing them all. Nothing
      announced it. Twelve green tests over a file the guard could barely read is worse than no
      guard: it produces confidence instead of coverage.

      Measured on DECLARATIONS rather than on bulk characters, because bulk is the wrong ruler:
      a small, heavily documented file is legitimately two-thirds comment, and stripping comments
      is the point. A top-level `function` or `const` is unambiguously code — if one disappears,
      the scanner has classified code as string, which is the exact fault being guarded against.
    */
    const DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+\w/gm;
    /*
      The baseline has COMMENTS removed and strings left alone, which isolates the one fault
      this is looking for. Counting against the raw file instead would flag the code samples
      these functions quote inside their own explanatory comments — `kiosk-punch` documents the
      bug it fixed by showing the two lines that caused it — and blanking those is correct.
    */
    const withoutComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    for (const file of FILES) {
      const raw = readFileSync(file.path, "utf8");
      const expected = (withoutComments(raw).match(DECLARATION) ?? []).length;
      const seen = (file.code.match(DECLARATION) ?? []).length;
      expect(expected, `${file.rel}: no declarations found, so this proves nothing`)
        .toBeGreaterThan(0);
      expect(
        seen,
        `${file.rel}: ${expected - seen} of ${expected} declarations were swallowed as string`,
      ).toBeGreaterThanOrEqual(expected);
    }
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
