/**
 * link-targets.test.ts — every click must land somewhere.
 *
 * THE BUG THIS LOCKS OUT
 * ----------------------
 * `AnalyticsKiosk.page.tsx` shipped a header button linking to
 * `/admin/kiosk/matches`. There is no such route — the screen is
 * `/admin/kiosk/match-review` — so the button rendered perfectly and dropped the
 * admin on the 404 page. Nothing caught it: `<Link to="...">` takes a plain string,
 * so TypeScript has nothing to check, and no test asserted that a link target is a
 * real route.
 *
 * That is the same family as the bug that prompted this file's sibling
 * (`src/features/admin/kioskReachability.test.ts`): navigation is the one part of
 * this app with no type safety at all, and it is the part the user experiences
 * first.
 *
 * WHAT IS CHECKED, AND WHY ONLY THIS
 * ----------------------------------
 * STATIC, absolute, parameter-free targets only — `to="/admin/kiosk/devices"`.
 * Deliberately NOT checked:
 *   * template literals (`` to={`/admin/people/${code}`} ``) — the static prefix is
 *     not a route on its own, and reconstructing the parameter would mean guessing;
 *   * anything with a query string — `/admin/audit?range=custom` is a real route
 *     plus state, and splitting on `?` to compare is fine but adds no safety that
 *     the bare-path check does not already give;
 *   * `navigate(...)` calls — same reasoning; the literal ones are covered by the
 *     grep below, the dynamic ones are not checkable here.
 * A narrow check that never cries wolf is worth more than a broad one everybody
 * learns to skip: this one found a real 404 on its first run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MANIFEST = readFileSync(join(ROOT, "src/app/route-manifest.ts"), "utf8");
const ROUTES_TSX = readFileSync(join(ROOT, "src/app/routes.tsx"), "utf8");

/**
 * Route paths from the manifest. TWO shapes live in that file — the ME/TEAM object
 * form and the ADMIN_ROWS tuple form — and reading only one silently halves the
 * list, which would make this test fail on dozens of perfectly good links.
 */
const MANIFEST_PATHS = [
  ...[...MANIFEST.matchAll(/\bpath:\s*"(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
  ...[...MANIFEST.matchAll(/^\s*\["(\/[^"]*)"/gm)].map((m) => m[1] ?? ""),
].filter((p) => p !== "");

/** Redirects are valid destinations: `/me/profile` -> `/me/profile/basic`. */
const REDIRECT_FROMS = [...MANIFEST.matchAll(/from:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");

/** Standalone/public routes mounted directly in routes.tsx, outside the shell. */
const STANDALONE = [...ROUTES_TSX.matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1] ?? "");

const VALID = new Set<string>([...MANIFEST_PATHS, ...REDIRECT_FROMS, ...STANDALONE, "/"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(join(ROOT, "src")).map((path) => ({
  rel: path.slice(ROOT.length + 1),
  code: readFileSync(path, "utf8"),
}));

/** A path is a route pattern match if every segment lines up, `:params` wild. */
function matchesRoute(target: string): boolean {
  if (VALID.has(target)) return true;
  const tSeg = target.split("/").filter(Boolean);
  return [...VALID].some((route) => {
    const rSeg = route.split("/").filter(Boolean);
    if (rSeg.length !== tSeg.length) return false;
    return rSeg.every((seg, i) => seg.startsWith(":") || seg === tSeg[i]);
  });
}

describe("every static link target is a real route", () => {
  it("read the route table at all — an empty VALID set would fail everything", () => {
    expect(MANIFEST_PATHS.length).toBeGreaterThan(150);
    expect(STANDALONE.length).toBeGreaterThan(3);
  });

  it("has no <Link to=\"...\"> pointing at a path the router does not serve", () => {
    const bad: string[] = [];
    for (const file of FILES) {
      // Static double-quoted absolute targets only: no `${`, no `?`, no `#`.
      for (const m of file.code.matchAll(/\b(?:to|href)="(\/[^"?#${}]*)"/g)) {
        const target = m[1] ?? "";
        if (!matchesRoute(target)) bad.push(`${target}  <- ${file.rel}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has no navigate(\"...\") pointing at a path the router does not serve", () => {
    const bad: string[] = [];
    for (const file of FILES) {
      for (const m of file.code.matchAll(/\bnavigate\(\s*"(\/[^"?#${}]*)"/g)) {
        const target = m[1] ?? "";
        if (!matchesRoute(target)) bad.push(`${target}  <- ${file.rel}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has no rail entry pointing at a path the router does not serve", () => {
    // The rail is the one navigation surface every user sees on every screen; a
    // dead entry there is a 404 one click from anywhere.
    const nav = readFileSync(join(ROOT, "src/app/shell/nav-model.ts"), "utf8");
    const bad = [...nav.matchAll(/to:\s*"([^"]+)"/g)]
      .map((m) => m[1] ?? "")
      .filter((target) => !matchesRoute(target));
    expect(bad).toEqual([]);
  });
});
