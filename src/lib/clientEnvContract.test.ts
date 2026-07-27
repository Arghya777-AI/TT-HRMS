/**
 * clientEnvContract.test.ts — the boot check must know about every variable the app
 * cannot start without.
 *
 * THE FAILURE THIS PREVENTS
 * -------------------------
 * `src/lib/env.ts` throws at module scope for a missing `VITE_` variable, which on a
 * misconfigured deploy renders a completely blank page — no React, no error boundary,
 * nothing. `src/lib/env-check.ts` exists so `main.tsx` can detect that BEFORE the
 * throwing module is imported and show a message instead.
 *
 * That only works while the two lists agree. Add a third required variable to
 * `env.ts` and forget `env-check.ts`, and the blank page comes straight back — with
 * the added confusion that the app now has a diagnostic screen which stays silent.
 * So the required set is PARSED OUT OF BOTH FILES and compared.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_CLIENT_ENV, missingClientEnv } from "./env-check";

const ROOT = process.cwd();
const ENV_TS = readFileSync(join(ROOT, "src/lib/env.ts"), "utf8");
const MAIN_TSX = readFileSync(join(ROOT, "src/main.tsx"), "utf8");

describe("client env contract", () => {
  it("checks every variable env.ts treats as required", () => {
    // `required("VITE_X", …)` is the throwing call. Whatever it names must be in the
    // non-throwing check too.
    const requiredInEnv = [...ENV_TS.matchAll(/required\(\s*"([A-Z0-9_]+)"/g)].map((m) => m[1] ?? "");
    expect(requiredInEnv.length).toBeGreaterThan(0);
    for (const name of requiredInEnv) {
      expect(REQUIRED_CLIENT_ENV as readonly string[], `${name} is required by env.ts but unchecked at boot`).toContain(name);
    }
  });

  it("claims nothing extra, so the diagnostic cannot block a working deploy", () => {
    // The reverse direction matters too: a name here that env.ts does NOT require
    // would refuse to start an app that would in fact have run fine.
    const requiredInEnv = new Set(
      [...ENV_TS.matchAll(/required\(\s*"([A-Z0-9_]+)"/g)].map((m) => m[1] ?? ""),
    );
    for (const name of REQUIRED_CLIENT_ENV) {
      expect(requiredInEnv.has(name), `${name} is checked at boot but not required by env.ts`).toBe(true);
    }
  });

  it("reports the missing names, not a bare boolean", () => {
    // Under vitest neither var is defined, which is exactly the deployed-and-broken
    // state — so this asserts the real diagnostic path rather than a mock of it.
    const missing = missingClientEnv();
    expect(Array.isArray(missing)).toBe(true);
    // Whatever the harness provides, the function must never invent a name.
    for (const name of missing) {
      expect(REQUIRED_CLIENT_ENV as readonly string[]).toContain(name);
    }
  });

  it("treats a blank string as missing, not as configured", () => {
    // `VITE_SUPABASE_URL=` in a dashboard is the commonest way to half-set a variable,
    // and an empty string would otherwise sail through to the Supabase client.
    expect(REQUIRED_CLIENT_ENV.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(ROOT, "src/lib/env-check.ts"), "utf8")).toMatch(/\.trim\(\)\s*===\s*""/);
  });

  it("main.tsx checks BEFORE importing anything that can throw at module scope", () => {
    /*
      The whole fix is an ordering property, and it is invisible in a diff: a static
      `import` of the app would be hoisted above this check by the module system and
      the blank page would return. So main.tsx must import the app DYNAMICALLY, and
      env-check must be the thing it consults first.
    */
    expect(MAIN_TSX).toMatch(/from "@\/lib\/env-check"/);
    expect(MAIN_TSX).toMatch(/import\("\.\/boot"\)/);
    // No static import of the app or its providers in this file.
    expect(MAIN_TSX).not.toMatch(/^import .*from "@\/app\/routes"/m);
    expect(MAIN_TSX).not.toMatch(/^import .*from "@\/app\/providers"/m);
  });

  it("env-check imports nothing, so it cannot itself throw at module scope", () => {
    // A module that could throw is useless as the thing that detects throwing.
    const check = readFileSync(join(ROOT, "src/lib/env-check.ts"), "utf8");
    expect(check).not.toMatch(/^import /m);
  });
});
