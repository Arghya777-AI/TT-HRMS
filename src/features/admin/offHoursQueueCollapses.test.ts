/**
 * The off-hours queue shows itself when there is something to decide, and not otherwise.
 *
 * ── WHY THIS PANEL COLLAPSES ─────────────────────────────────────────────────
 * It sits at the top of the Overview tab, and an EMPTY queue was occupying roughly the top
 * third of the screen to say "Nothing waiting" — pushing PRESENT / ABSENT / ON LEAVE, which
 * is what an administrator opens the page for, below the fold.
 *
 * The rule has to hold in three directions and the interesting ones are the negatives:
 *   · empty              -> shut, because there is nothing to act on;
 *   · one or more rows    -> open on its own, WITHOUT anybody clicking, because a punch
 *                           waiting on a decision is the whole point of the panel;
 *   · failed to load      -> open, because a collapsed panel hiding "could not load" reports
 *                           a broken query as calmly as a genuinely empty queue, and those
 *                           two must never look alike.
 *
 * A manual click wins — until the row count moves, at which point it is dropped. Otherwise an
 * administrator who collapsed a one-row queue would never be shown the next arrival, which is
 * precisely the failure the panel exists to prevent. That reset lives in the component's
 * effect; the rule it resets is this function.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldExpandQueue } from "./offHoursQueue";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const panel = strip(read("src", "features", "admin", "components", "OffHoursApprovals.tsx"));

describe("the default is derived from the queue, not remembered", () => {
  it("is shut when nothing is waiting", () => {
    // THE REGRESSION THIS EXISTS FOR.
    expect(shouldExpandQueue(null, 0, false)).toBe(false);
  });

  it("is open the moment one punch is waiting, with nobody clicking", () => {
    expect(shouldExpandQueue(null, 1, false)).toBe(true);
    expect(shouldExpandQueue(null, 12, false)).toBe(true);
  });

  it("is open when the query failed, even with no rows to show", () => {
    /*
      An empty list and a failed read look identical once collapsed. This is the one case
      where the panel opens to show something that is not work.
    */
    expect(shouldExpandQueue(null, 0, true)).toBe(true);
  });
});

describe("a manual click wins while it lasts", () => {
  it("can be opened over an empty queue", () => {
    expect(shouldExpandQueue(true, 0, false)).toBe(true);
  });

  it("can be shut over a queue with work in it", () => {
    expect(shouldExpandQueue(false, 3, false)).toBe(false);
  });

  it("can be shut even over a failure — the admin has seen it", () => {
    expect(shouldExpandQueue(false, 0, true)).toBe(false);
  });
});

describe("the component drops that click when the count moves", () => {
  it("resets the override on any change in the number waiting", () => {
    /*
      Without this, collapsing a one-row queue would silently swallow every later arrival:
      the override says "shut" forever and no new punch can reopen it.
    */
    expect(panel).toContain("if (lastCount.current !== rows.length)");
    expect(panel).toContain("setOverride(null)");
    expect(panel).toContain("}, [rows.length]);");
  });

  it("derives the open state through the tested rule rather than inline", () => {
    expect(panel).toContain("shouldExpandQueue(override, rows.length, failed)");
    expect(panel).toContain("const failed = pending.error != null;");
  });
});

describe("collapsed, it is still reachable and still announced", () => {
  it("puts the toggle on the header and wires it to the body", () => {
    expect(panel).toContain("aria-expanded={expanded}");
    expect(panel).toContain("aria-controls={PANEL_BODY_ID}");
    expect(panel).toContain('id={PANEL_BODY_ID} hidden={!expanded}');
  });

  it("hides with `hidden`, so the rows leave the accessibility tree too", () => {
    /*
      Not a height/overflow trick: a screen reader would still walk a visually collapsed
      panel and read out punches nobody can see or reach with a keyboard.
    */
    expect(panel).toContain("hidden={!expanded}");
    expect(panel).not.toContain("max-h-0");
  });

  it("keeps the count badge visible when shut, because that is the actionable part", () => {
    const header = panel.slice(panel.indexOf("<button"), panel.indexOf("</button>"));
    expect(header).toContain("{rows.length}");
    expect(header).toContain('t("admin.offHours.title")');
  });

  it("labels the toggle in both directions", () => {
    // `t()` has no missing-key fallback, so both keys have to exist for real.
    const en = read("src", "shared", "i18n", "en.ts");
    expect(en).toContain('"admin.offHours.toggle.expand"');
    expect(en).toContain('"admin.offHours.toggle.collapse"');
    expect(en).toContain('"admin.offHours.collapsedEmpty"');
  });
});
