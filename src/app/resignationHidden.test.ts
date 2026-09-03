/**
 * A normal employee cannot reach the resignation form.
 *
 * ── THE INSTRUCTION, AND WHY THE FIRST ATTEMPT WAS NOT ENOUGH ────────────────
 * "They shouldn't think like that, right? So let's not give the option." The Apply tile was
 * withdrawn first, via `SUPPRESSED_CODES` in the launcher — and that only closed ONE door.
 *
 * The command palette offers every navigable route the reader's own capabilities allow
 * (`SEARCHABLE_ROUTES.filter((route) => can(route.cap))`), and the route carried `me.view`,
 * which every employee holds. So an employee typing "resign" still found it. The completeness
 * of that palette is a deliberate invariant with its own test, so removing the route from the
 * searchable set would have fought the design rather than used it.
 *
 * The CAP is the one lever that closes every entrance at once — the palette today, and any
 * link somebody adds later. HIDDEN, NOT DELETED: the screen, its route and its form are
 * untouched, an admin still reaches it, and one word restores it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "@/app/route-manifest";
import { SEARCHABLE_ROUTES } from "@/app/shell/commandSearch";
import { capsForRoles } from "@/shared/auth/capabilities";

const RESIGNATION = "/me/apply/resignation";

/** What the palette would offer somebody holding exactly these roles. */
function paletteFor(roles: readonly string[], opts: { isManager?: boolean } = {}): string[] {
  const caps = capsForRoles(roles, opts);
  return SEARCHABLE_ROUTES.filter((r) => caps.has(r.cap)).map((r) => r.path);
}

describe("the resignation form is hidden from employees", () => {
  it("is not in a plain employee's command palette", () => {
    // The door the tile-only fix left open.
    expect(paletteFor(["employee"])).not.toContain(RESIGNATION);
  });

  it("is not in a manager's either", () => {
    /*
      A manager is still a normal employee for their own /me screens — they resign by talking
      to HR like anybody else.
    */
    expect(paletteFor(["employee", "manager"], { isManager: true })).not.toContain(RESIGNATION);
  });

  it("IS still there for an admin", () => {
    // "Normal employee views" was the instruction. An administrator loses nothing.
    expect(paletteFor(["admin"])).toContain(RESIGNATION);
    expect(paletteFor(["super_admin"])).toContain(RESIGNATION);
  });

  it("still exists as a route, with its screen", () => {
    /*
      Hidden, not removed. If this ever fails, somebody has deleted the feature rather than
      withdrawing its entrance, and restoring it is no longer one word.
    */
    expect(ROUTES.some((r) => r.path === RESIGNATION)).toBe(true);
  });

  it("is closed by the CAP, not by a second suppression list", () => {
    /*
      One lever, so a link added later is covered too. A palette-only exclusion would have to
      be remembered again for every new entrance — which is exactly how the tile fix came to be
      incomplete.
    */
    expect(ROUTES.find((r) => r.path === RESIGNATION)?.cap).toBe("admin.access");
  });

  it("keeps the Apply tile withdrawn as well", () => {
    /*
      Belt and braces: the cap alone would leave an admin seeing a Resignation TILE on their own
      Apply page, which is a self-service screen they have no use for.
    */
    /*
      `readFileSync` from cwd, like every other source assertion in this repo. An
      `import.meta.url`-relative URL failed here — Vitest serves the module over a non-file
      scheme, so the URL is not a path.
    */
    /*
      Comments stripped first. The unstripped version failed because the note explaining the
      withdrawal sits BETWEEN the set and the entry and is longer than any sane match window —
      and widening the window would have made the assertion pass on a mention in prose, which
      is the false positive this repo has hit four times.
    */
    const src = readFileSync(
      join(process.cwd(), "src", "features", "apply", "pages", "ApplyLauncher.page.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/SUPPRESSED_CODES[\s\S]{0,200}"RESIGNATION"/);
  });

  it("does not touch the employee's other Apply screens", () => {
    // The withdrawal is one route, not a section.
    const employee = paletteFor(["employee"]);
    expect(employee).toContain("/me/apply/claim");
    expect(employee).toContain("/me/apply/overtime");
    expect(employee).toContain("/me/regularizations/new");
  });
});
