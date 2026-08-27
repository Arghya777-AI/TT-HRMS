/**
 * recovered.test.ts — placeholder copy must not reach a screen again.
 *
 * WHAT HAPPENED
 * -------------
 * `recovered.ts` was generated to keep 14 screens compiling after their authoring
 * agents were killed mid-task: each value started as the key's own last segment.
 * That kept the build green and shipped copy like a banner whose title and body
 * both read "No Engine", above tiles hinted "Carry hint 1".
 *
 * A client opened Year-End Rollover and asked what the error was. Placeholder
 * copy does not read as unfinished to somebody using the product — it reads as
 * broken.
 *
 * WHAT THIS GUARDS
 * ----------------
 * Only PROSE slots — help, hint, note, body, description, subtitle, footnote and
 * friends. A LABEL that matches its key name is usually correct ("Cap", "Status",
 * "Dry run"), and asserting otherwise would be churn that breaks working headings.
 *
 * If this fails, a prose key is showing its own name to a user. Write the
 * sentence; the page's header comment almost always already says it.
 */
import { describe, expect, it } from "vitest";
import { keysRecovered } from "./recovered";

/** A key segment that means "this is explanatory text", not a label. */
const PROSE_SLOTS = new Set([
  "help", "hint", "note", "notes", "body", "description", "intro", "summary",
  "footnote", "explain", "caption", "banner", "subtitle",
]);

/** "carryHint" → "carry hint", so a value can be compared with its own name. */
function segmentWords(key: string): string {
  const last = key.split(".").at(-1) ?? "";
  return last.replace(/(?<!^)(?=[A-Z])/g, " ").toLowerCase().trim();
}

function isProse(key: string): boolean {
  return key.toLowerCase().split(".").some((part) => PROSE_SLOTS.has(part));
}

describe("recovered i18n copy", () => {
  it("has no prose key that just repeats its own name", () => {
    const echoes = Object.entries(keysRecovered)
      .filter(([key, value]) => isProse(key) && value.replace(/\.$/, "").toLowerCase() === segmentWords(key))
      // A column header called "Notes" is a label, not prose about notes.
      .filter(([key]) => !key.includes(".col."))
      .map(([key, value]) => `${key} = "${value}"`);
    expect(
      echoes,
      "These render their own key name to a user, which reads as a bug rather than as unfinished work.",
    ).toEqual([]);
  });

  it("has no prose key left as a bare 'X hint' or 'X drill' stub", () => {
    const stubs = Object.entries(keysRecovered)
      .filter(([key]) => isProse(key))
      .filter(([, value]) => /^[a-z ]*(hint|drill)( \{[a-z]+\})?\.?$/i.test(value))
      .map(([key, value]) => `${key} = "${value}"`);
    expect(stubs).toEqual([]);
  });

  it("still holds the screens it was written for", () => {
    // If this collapses, the guard above has become vacuous.
    expect(Object.keys(keysRecovered).length).toBeGreaterThan(1000);
  });

  /*
    THE YEAR-END ROLLOVER STOPPED BEING A DESCRIPTION AND BECAME A CONTROL.

    `/admin/leave/rollover` shipped for months saying "this screen reviews the year
    end; it cannot run it", which was true until `rollover_leave_year` was deployed
    (migration 20260827110000). The copy that said so has to go with it: a screen
    carrying both a working commit button and a paragraph explaining that no engine
    exists is worse than either alone.
  */
  it("no longer claims the rollover has no engine", () => {
    const stale = Object.keys(keysRecovered).filter((k) => k.includes("rollover.noEngine"));
    expect(
      stale,
      "rollover_leave_year is deployed; copy saying otherwise contradicts the button next to it",
    ).toEqual([]);
  });

  it("carries the copy the rollover controls need", () => {
    for (const key of [
      "adminLeave.rollover.engine.title",
      "adminLeave.rollover.engine.body",
      "adminLeave.rollover.action.dryRun",
      "adminLeave.rollover.action.commit",
      "adminLeave.rollover.action.dryRunTitle",
      "adminLeave.rollover.action.commitTitle",
      "adminLeave.rollover.result.heading",
      "adminLeave.rollover.result.line",
      "adminLeave.rollover.result.negatives",
      "adminLeave.rollover.notYetEnded",
      "admin.leaveBal.adjustBalance",
      "admin.leaveBal.adjust",
      "admin.leaveBal.col.adjust",
    ]) {
      expect(keysRecovered, `${key} is missing`).toHaveProperty(key);
      expect(String((keysRecovered as Record<string, string>)[key]).length).toBeGreaterThan(2);
    }
  });

  /*
    The interpolation slots are the half a missing-key test cannot see: `t()` leaves
    an unreplaced {token} on screen, which reads as a bug in the page rather than in
    the catalogue.
  */
  it("keeps the interpolation slots the rollover screen passes", () => {
    const slots: Record<string, readonly string[]> = {
      "adminLeave.rollover.action.dryRunTitle": ["year"],
      "adminLeave.rollover.action.commitTitle": ["year"],
      "adminLeave.rollover.notYetEnded": ["year", "end"],
      "adminLeave.rollover.result.line": ["type", "employees", "carried", "lapsed"],
      "adminLeave.rollover.result.negatives": ["count"],
    };
    for (const [key, tokens] of Object.entries(slots)) {
      const copy = String((keysRecovered as Record<string, string>)[key] ?? "");
      for (const token of tokens) {
        expect(copy, `${key} must interpolate {${token}}`).toContain(`{${token}}`);
      }
    }
  });
});
