/**
 * Both halves of one date — HD-2026-000007.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 * Darshan P V (073) had a half-day Week-off approved for 5 Sep 2026. He then tried four times
 * in eleven minutes to book the OTHER half so the date would read as one full day, and raised
 * a ticket in the middle of the attempts: "Convert this into one day / Not able to mark an
 * other half day week off or to change for 1". Every attempt died on
 *
 *     23P01: leave request overlaps existing request LV-2026-000042 for the same employee
 *
 * because `leave_requests_no_overlap` compared date RANGES and never read `portion`. An
 * approved morning reserved the whole calendar date against its own afternoon.
 *
 * ── THREE DEFECTS, NOT ONE ───────────────────────────────────────────────────
 * 1. THE GUARD refused opposite halves of a date. Fixed by exempting exactly that case.
 * 2. THE FORM could not express the second half. `splitAllocationsAcrossDates` hardcoded
 *    `first_half`, so even with the guard relaxed every application would have asked for the
 *    half he already held — and been refused again, correctly.
 * 3. ATTENDANCE would have priced two approved halves at 0.5. `compute_attendance_day` read
 *    the date's leave with `SELECT ... LIMIT 1`, so the second row was invisible. Without this
 *    the first two fixes deliver a day that is fully booked and half paid, which is worse than
 *    the refusal it replaces.
 *
 * Verified live against his own rows, rolled back: second_half accepted, first_half and
 * full_day still refused against LV-2026-000042, and the recomputed day moved from
 * `on_leave_half / 0.500` to `on_leave / 1.000`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitAllocationsAcrossDates } from "./leaveRange";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*--.*$/gm, "");

const sql = strip(read("supabase", "migrations", "20260907090000_a_day_can_hold_both_of_its_halves.sql"));
const form = strip(read("src", "features", "leave", "pages", "LeaveApplication.page.tsx"));
const range = strip(read("src", "features", "leave", "leaveRange.ts"));
const dialog = strip(read("src", "features", "admin", "components", "CancelLeaveDaysDialog.tsx"));

describe("the splitter stamps the half it was given", () => {
  const dates = ["2026-09-05"];

  it("uses the second half when asked for it", () => {
    const { segments } = splitAllocationsAcrossDates(dates, [{ typeId: "wo", days: 0.5 }], "second_half");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.portion).toBe("second_half");
    expect(segments[0]?.expectedDays).toBe(0.5);
  });

  it("still defaults to the first half, so every existing caller is unchanged", () => {
    const { segments } = splitAllocationsAcrossDates(dates, [{ typeId: "wo", days: 0.5 }]);
    expect(segments[0]?.portion).toBe("first_half");
  });

  it("leaves whole days alone whichever half is chosen", () => {
    const { segments } = splitAllocationsAcrossDates(
      ["2026-09-05", "2026-09-06"], [{ typeId: "el", days: 2 }], "second_half",
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.portion).toBe("full_day");
  });

  it("puts the half on the tail of a 2.5-day allocation, not on the whole part", () => {
    const { segments } = splitAllocationsAcrossDates(
      ["2026-09-05", "2026-09-06", "2026-09-07"], [{ typeId: "el", days: 2.5 }], "second_half",
    );
    expect(segments.map((s) => s.portion)).toEqual(["full_day", "second_half"]);
    expect(segments[1]?.fromDate).toBe("2026-09-07");
    expect(segments[1]?.fromDate).toBe(segments[1]?.toDate);
  });
});

describe("the overlap guard exempts opposite halves and nothing else", () => {
  it("still refuses any live request whose dates touch another", () => {
    expect(sql).toContain("daterange(lr.from_date, lr.to_date, '[]') && daterange(NEW.from_date, NEW.to_date, '[]')");
    expect(sql).toContain("leave request overlaps existing request %");
  });

  it("requires ALL FOUR conditions before it lets a date be shared", () => {
    const exemption = sql.slice(sql.indexOf("AND NOT ("), sql.indexOf("LIMIT 1"));
    // both single-date, same date, both halves, and DIFFERENT halves
    expect(exemption).toContain("v_new_half");
    expect(exemption).toContain("lr.from_date = lr.to_date");
    expect(exemption).toContain("lr.from_date = NEW.from_date");
    expect(exemption).toContain("lr.portion <> 'full_day'");
    expect(exemption).toContain("lr.portion <> NEW.portion");
  });

  it("only treats the incoming row as a half when it is a single date", () => {
    expect(sql).toContain("v_new_half := (NEW.from_date = NEW.to_date AND NEW.portion <> 'full_day')");
  });

  it("leaves the statuses it polices untouched", () => {
    expect(sql).toContain("'pending','approved','partially_approved','cancellation_pending'");
  });
});

describe("attendance adds the halves up", () => {
  it("sums the date's leave rows instead of taking the first", () => {
    expect(sql).toContain("LEAST(SUM(lrd.day_value), 1.0)");
    expect(sql).not.toContain("SELECT lr.id, lt.id, lt.is_paid, lrd.day_value");
  });

  it("drops the LIMIT 1 that hid the second row", () => {
    const lookup = sql.slice(sql.indexOf("FROM public.leave_request_days lrd"));
    expect(lookup.slice(0, lookup.indexOf(";"))).not.toContain("LIMIT 1");
  });

  it("prices the day from the PAID share, so a paid half beside an unpaid one pays half", () => {
    expect(sql).toContain("FILTER (WHERE lt.is_paid)");
    expect(sql).toContain("v_fraction := COALESCE(v_leave_paid_value, 0);");
    // the old all-or-nothing boolean must no longer decide the fraction
    expect(sql).not.toContain("CASE WHEN v_leave_is_paid THEN 1.0 ELSE 0.0 END");
    expect(sql).not.toContain("CASE WHEN v_leave_is_paid THEN 0.5 ELSE 0.0 END");
  });

  it("still adds the worked half of a half-leave day", () => {
    expect(sql).toContain("CASE WHEN v_payable >= v_half THEN 0.5 ELSE 0.0 END");
  });

  it("picks a stable representative when two rows share the date", () => {
    expect(sql).toContain("ORDER BY lrd.portion, lr.created_at");
  });
});

describe("the employee can say which half", () => {
  it("holds the choice and hands it to the splitter", () => {
    expect(form).toContain('useState<HalfPortion>("first_half")');
    expect(form).toContain("splitAllocationsAcrossDates(countedDatesOf(summary.dates), allocations, halfPortion)");
  });

  it("re-runs the split when the half changes", () => {
    expect(form).toContain("[summary.dates, allocations, halfPortion]");
  });

  it("offers both halves", () => {
    expect(form).toContain('["first_half", "second_half"] as const');
    expect(form).toContain("setHalfPortion(option)");
  });

  it("shows the control only when the total actually ends in .5", () => {
    expect(form).toContain("{endsInHalf ? (");
    expect(form).toContain("Math.abs((total % 1) - 0.5) < 1e-9");
  });

  it("sends the segment's own portion rather than casting it back to a first half", () => {
    expect(form).toContain("portion: segment.portion,");
    expect(range).not.toContain('portion: "first_half",');
  });
});

describe("every admin edit can change the half too", () => {
  it("offers all three portions from one vocabulary", () => {
    expect(dialog).toContain("PORTION_CHOICES");
    expect(dialog).toContain('{ value: "first_half", label: t("admin.leaveFor.portion.first") }');
    expect(dialog).toContain('{ value: "second_half", label: t("admin.leaveFor.portion.second") }');
    expect(dialog).toContain('{ value: "full_day", label: t("admin.leaveFor.portion.full") }');
  });

  it("seeds from the booking and sends what the admin chose", () => {
    expect(dialog).toContain('setEditPortion((cancellable[0]?.portion ?? "full_day") as LeavePortion)');
    expect(dialog).toContain('portion: editSingleDate ? editPortion : "full_day",');
  });

  it("hides the control across a range, where the server discards the answer", () => {
    expect(dialog).toContain("editSingleDate = editFrom !== \"\" && editFrom === editTo");
    expect(dialog).toContain("{editSingleDate ? (");
  });

  it("reaches all three admin surfaces through the one shared dialog", () => {
    for (const f of [
      ["src", "features", "admin", "pages", "LeaveRequests.page.tsx"],
      ["src", "features", "admin", "pages", "OrgLeaveCalendar.page.tsx"],
      ["src", "features", "admin", "components", "LeaveCalendarBand.tsx"],
    ]) {
      expect(read(...f)).toContain("<CancelLeaveDaysDialog");
    }
  });
});
