/**
 * A link that says "for this person" must arrive filtered to that person.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * `EmployeeAttendance.page.tsx` renders "All scans for this person" as
 *
 *     /admin/attendance/punches?employee=<uuid>
 *
 * and `PunchLog.page.tsx` read `params.get("emp")`. Two spellings of the same idea,
 * written on different days, never compared. The button navigated correctly, the page
 * rendered correctly, and the filter was empty — so it showed every employee's scans,
 * which is precisely what its label promises it will not do. Reported as "otherwise
 * there is no point", which is the right reaction.
 *
 * A sweep of every internal link carrying a query string against what each target page
 * actually reads found 23 of these across 12 pages. Four are on this page:
 *
 *     ?employee=  from EmployeeAttendance    (read as nothing -> every employee)
 *     ?date=      from EmployeeAttendance, DayRecords, command-vocab
 *                                            (read as nothing -> default 30-day range)
 *     ?review=true from command-vocab        (tested against "1" -> flag ignored)
 *
 * None of them broke in a rename. They never worked once.
 *
 * ── WHY REWRITE RATHER THAN READ BOTH ────────────────────────────────────────
 * The employee dropdown writes `emp`. Accepting both spellings in the reader leaves
 * `?employee=X&emp=Y` in the URL after one dropdown change, and clearing the dropdown
 * then resurrects X instead of clearing the filter. Normalising on arrival means the
 * URL only ever carries canonical keys, so clearing clears.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPunchLogParams, isOn } from "./punchLogParams";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** The canonical query string for an incoming one, as the page would end up with it. */
const canon = (qs: string): string => {
  const out = canonicalPunchLogParams(new URLSearchParams(qs));
  return out === null ? qs : out.toString();
};

describe("the link the employee's page actually renders", () => {
  it("is the one this page normalises", () => {
    /*
      Pinning the producer to the consumer. If the button's key is ever changed, this
      fails here instead of silently showing the whole company again.
    */
    const page = read("src", "features", "admin", "pages", "EmployeeAttendance.page.tsx");
    expect(page).toContain("/admin/attendance/punches?employee=${encodeURIComponent(person.id)}");
  });

  it("arrives filtered to that person", () => {
    // THE REGRESSION THIS EXISTS FOR.
    expect(canon("employee=abc-123")).toBe("emp=abc-123");
  });

  it("keeps the rest of the query while doing it", () => {
    const out = new URLSearchParams(canon("from=2026-09-01&employee=abc&source=kiosk_face"));
    expect(out.get("emp")).toBe("abc");
    expect(out.get("from")).toBe("2026-09-01");
    expect(out.get("source")).toBe("kiosk_face");
    expect(out.get("employee")).toBeNull();
  });
});

describe("a day-scoped link lands on that day", () => {
  it("spells one day as both ends of the range", () => {
    const out = new URLSearchParams(canon("date=2026-09-04"));
    expect(out.get("from")).toBe("2026-09-04");
    expect(out.get("to")).toBe("2026-09-04");
    expect(out.get("date")).toBeNull();
  });

  it("does not overrule a range that was given explicitly", () => {
    const out = new URLSearchParams(canon("date=2026-09-04&from=2026-08-01&to=2026-08-31"));
    expect(out.get("from")).toBe("2026-08-01");
    expect(out.get("to")).toBe("2026-08-31");
    expect(out.get("date")).toBeNull();
  });

  it("carries the person and the day together", () => {
    // Both aliases on one link — which is what the attendance grid sends.
    const out = new URLSearchParams(canon("employee=e1&date=2026-09-04"));
    expect(out.get("emp")).toBe("e1");
    expect(out.get("from")).toBe("2026-09-04");
    expect(out.get("to")).toBe("2026-09-04");
  });
});

describe("a flag is on in either spelling", () => {
  it("accepts the Command Palette's `true` and the page's own `1`", () => {
    expect(isOn("true")).toBe(true);
    expect(isOn("1")).toBe(true);
  });

  it("is off for everything else, including the words that look on", () => {
    for (const v of [null, "", "0", "false", "yes", "TRUE"]) expect(isOn(v), String(v)).toBe(false);
  });

  it("settles `review=true` to the canonical spelling", () => {
    expect(canon("review=true")).toBe("review=1");
    expect(canon("voided=true")).toBe("voided=1");
  });

  it("still matches what the Command Palette sends", () => {
    const vocab = read("src", "features", "admin", "command-vocab.ts");
    expect(vocab).toContain("/admin/attendance/punches?review=true");
  });
});

describe("normalising cannot loop", () => {
  it("reports nothing to do for an already-canonical URL", () => {
    /*
      The effect writes back only on a non-null return. If a canonical URL still
      reported a change, setParams would re-run the effect forever and the page would
      hang — so this is the guard that keeps that impossible.
    */
    for (const qs of ["emp=abc", "from=2026-09-01&to=2026-09-04", "review=1", "", "voided=1"]) {
      expect(canonicalPunchLogParams(new URLSearchParams(qs)), qs).toBeNull();
    }
  });

  it("is settled after exactly one pass", () => {
    const once = canonicalPunchLogParams(new URLSearchParams("employee=e1&date=2026-09-04&review=true"));
    expect(once).not.toBeNull();
    expect(canonicalPunchLogParams(once as URLSearchParams)).toBeNull();
  });
});

describe("an empty alias clears rather than filtering on nothing", () => {
  it("drops `employee=` without writing an empty `emp`", () => {
    // `emp=` would render as a selected-but-blank dropdown.
    expect(canon("employee=")).toBe("");
  });

  it("drops `date=` without inventing a range", () => {
    expect(canon("date=")).toBe("");
  });

  it("lets an explicit `emp` win over an alias", () => {
    // The dropdown is a later, more deliberate act than the link that opened the page.
    expect(canon("employee=fromLink&emp=fromDropdown")).toBe("emp=fromDropdown");
  });
});
