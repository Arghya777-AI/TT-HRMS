/**
 * A deploy must not leave somebody on a dead page.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 * "Failed to fetch dynamically imported module: .../assets/Home.page-rwB3PVrE.js" — the
 * dashboard, blank.
 *
 * Not a bug in the page. Vite fingerprints every chunk, so a deploy replaces
 * `Home.page-<old>.js` with `Home.page-<new>.js`. A browser that loaded the shell BEFORE the
 * deploy is still holding a module graph that names the old file, asks for a chunk this
 * deployment no longer serves, and React's `lazy` has nothing to render.
 *
 * The window is small and it is exactly the wrong window: a tab left open overnight, opened at
 * 8am after the night's deploy, dead on the first touch — and the employee has no way of
 * knowing that a hard reload is the fix.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isChunkLoadFailure } from "./lazyWithRecovery";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const src = strip(read("src", "app", "lazyWithRecovery.ts"));
const routes = strip(read("src", "app", "routes.tsx"));

describe("it recognises a stale chunk, and only a stale chunk", () => {
  it("matches what each browser actually says", () => {
    /*
      Matched on the message rather than a type, because they disagree: Chrome throws
      "Failed to fetch dynamically imported module", Firefox "error loading dynamically
      imported module", Safari "Importing a module script failed".
    */
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/assets/Home.page-rwB3PVrE.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "ChunkLoadError: Loading chunk 42 failed.",
    ]) {
      expect(isChunkLoadFailure(new Error(message)), message).toBe(true);
    }
  });

  it("does NOT match an ordinary runtime error from inside the page", () => {
    /*
      THE ONE THAT MATTERS. A broad match would reload the tab on a real bug, hiding it and
      making it unreportable — the page would just flicker forever instead of showing what
      broke.
    */
    for (const message of [
      "Cannot read properties of undefined (reading 'map')",
      "NetworkError when attempting to fetch resource.",
      "supabase: JWT expired",
      "",
    ]) {
      expect(isChunkLoadFailure(new Error(message)), message).toBe(false);
    }
  });

  it("survives being handed something that is not an Error", () => {
    expect(isChunkLoadFailure(null)).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
    expect(isChunkLoadFailure("Failed to fetch dynamically imported module")).toBe(true);
  });
});

describe("it reloads once, never in a loop", () => {
  it("remembers the attempt before reloading", () => {
    // A reload loop is far worse than an error message.
    const order = src.indexOf("writeFlag(true);");
    const reload = src.indexOf("window.location.reload();");
    expect(order).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(order);
  });

  it("rethrows when a reload has already been tried", () => {
    // Then it is not a stale chunk; the asset really is gone, and the boundary must show it.
    expect(src).toContain("if (isChunkLoadFailure(error) && !readFlag()) {");
    expect(src).toContain("throw error;");
  });

  it("clears the flag on a successful load, so a later failure still gets its attempt", () => {
    expect(src).toContain("writeFlag(false);");
  });

  it("never resolves after starting a reload", () => {
    // Resolving with a placeholder would flash it before the document is replaced.
    expect(src).toContain("new Promise<{ default: T }>(() => undefined)");
  });

  it("does not die where sessionStorage throws", () => {
    // Private modes throw on access; a recovery path that crashes is not one.
    expect(src).toContain("try {\n    return window.sessionStorage.getItem(FLAG) === \"1\";");
  });
});

describe("every registered route goes through it", () => {
  it("wraps the registry loader rather than calling lazy directly", () => {
    expect(routes).toContain("if (loader) return lazyWithRecovery(loader);");
    expect(routes).not.toContain("if (loader) return lazy(loader);");
  });
});
