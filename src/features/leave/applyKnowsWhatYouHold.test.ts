/**
 * The apply screen reads what you already hold, and says the useful thing.
 *
 * The guard now lets a date carry opposite halves, but that rule is invisible from the form:
 * an employee holding the first half of 5 Sep who asks for another half day gets
 * "overlaps existing request LV-2026-000042" and no idea that the answer is to pick the other
 * half. Darshan P V tried four times and raised a ticket rather than work it out.
 *
 * So the screen looks the dates up first and offers the free half by name. The database is
 * still the authority — every case below is refused there too. This is only the difference
 * between a refusal an employee can act on and one they cannot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adviseOnBooked, endsInHalf, opposite, type BookedLeave } from "./alreadyBooked";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*--.*$/gm, "");

const page = strip(read("src", "features", "leave", "pages", "LeaveApplication.page.tsx"));
const api = strip(read("src", "features", "leave", "api", "leave-apply.api.ts"));
const hooks = strip(read("src", "features", "leave", "hooks", "useLeaveApply.ts"));

const DATE = "2026-09-05";
const half = (portion: string, date = DATE): BookedLeave => ({
  requestNumber: "LV-2026-000042",
  fromDate: date,
  toDate: date,
  portion,
  typeName: "Week-off",
});
const ask = (over: Partial<Parameters<typeof adviseOnBooked>[0]> = {}) =>
  adviseOnBooked({
    fromDate: DATE,
    toDate: DATE,
    totalDays: 0.5,
    chosenHalf: "second_half",
    bookings: [],
    ...over,
  });

describe("endsInHalf tolerates a total built by addition", () => {
  it("accepts the halves and refuses the wholes", () => {
    expect(endsInHalf(0.5)).toBe(true);
    expect(endsInHalf(2.5)).toBe(true);
    expect(endsInHalf(0.1 + 0.2 + 0.2)).toBe(true); // 0.5000000000000001
    expect(endsInHalf(1)).toBe(false);
    expect(endsInHalf(0)).toBe(false);
  });
  it("opposite is an involution", () => {
    expect(opposite("first_half")).toBe("second_half");
    expect(opposite(opposite("first_half"))).toBe("first_half");
  });
});

describe("nothing in the way", () => {
  it("says nothing when there are no bookings", () => {
    expect(ask().kind).toBe("none");
  });
  it("ignores a booking that does not touch the range", () => {
    expect(ask({ bookings: [half("first_half", "2026-09-09")] }).kind).toBe("none");
  });
  it("says nothing about a half-typed or inverted range", () => {
    expect(ask({ fromDate: "" }).kind).toBe("none");
    expect(ask({ fromDate: "2026-09-09", toDate: "2026-09-05" }).kind).toBe("none");
  });
});

describe("one half held, the other free", () => {
  it("names the free half and confirms it makes a full day", () => {
    const a = ask({ bookings: [half("first_half")], chosenHalf: "second_half" });
    expect(a.kind).toBe("complement");
    if (a.kind !== "complement") return;
    expect(a.heldPortion).toBe("first_half");
    expect(a.suggestPortion).toBe("second_half");
    expect(a.chosenIsFree).toBe(true);
    expect(a.requestNumber).toBe("LV-2026-000042");
    expect(a.typeName).toBe("Week-off");
  });

  it("flags the choice when they picked the half that is already taken", () => {
    const a = ask({ bookings: [half("first_half")], chosenHalf: "first_half" });
    expect(a.kind).toBe("complement");
    if (a.kind !== "complement") return;
    expect(a.chosenIsFree).toBe(false);
  });

  it("works the other way round too", () => {
    const a = ask({ bookings: [half("second_half")], chosenHalf: "first_half" });
    expect(a.kind).toBe("complement");
    if (a.kind !== "complement") return;
    expect(a.suggestPortion).toBe("first_half");
    expect(a.chosenIsFree).toBe(true);
  });

  it("offers 0.5 rather than a refusal when they asked for a whole day", () => {
    const a = ask({ bookings: [half("first_half")], totalDays: 1 });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.why).toBe("needHalfDay");
    expect(a.suggestPortion).toBe("second_half");
  });
});

describe("the date is genuinely gone", () => {
  it("refuses a full-day booking", () => {
    const a = ask({ bookings: [{ ...half("full_day") }] });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.why).toBe("fullDay");
  });

  it("refuses when BOTH halves are already held", () => {
    const a = ask({
      bookings: [half("first_half"), { ...half("second_half"), requestNumber: "LV-2026-000045" }],
    });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.why).toBe("fullDay");
  });

  it("does not read a stale half label on a multi-day booking as a free half", () => {
    /* `rebuild_leave_request_days` forces full_day across a range, so this row is a full-day
       booking wearing a first_half label. Offering its complement would be a lie. */
    const a = ask({
      bookings: [{ ...half("first_half"), fromDate: "2026-09-04", toDate: "2026-09-06" }],
    });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.why).toBe("fullDay");
  });

  it("names the date the employee picked, not the date the booking starts", () => {
    const a = ask({
      bookings: [{ ...half("full_day"), fromDate: "2026-09-04", toDate: "2026-09-06" }],
    });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.date).toBe("2026-09-05");
  });

  it("refuses a multi-date request that reaches over a half-day booking", () => {
    const a = ask({ toDate: "2026-09-07", totalDays: 2.5, bookings: [half("first_half")] });
    expect(a.kind).toBe("blocked");
    if (a.kind !== "blocked") return;
    expect(a.why).toBe("rangeCoversBooking");
  });
});

describe("the read behind the advice", () => {
  it("counts a PENDING request as holding its dates, like the guard does", () => {
    /* Scoped to the constant itself. Asserting on the whole file let a mutation that DELETED
       "pending" from this list still pass, because the word occurs elsewhere in it. */
    const from = api.indexOf("export const LIVE_LEAVE_STATUSES");
    expect(from).toBeGreaterThan(-1);
    const list = api.slice(from, api.indexOf("] as const", from));
    for (const status of ["pending", "approved", "partially_approved", "cancellation_pending"]) {
      expect(list).toContain(`"${status}"`);
    }
    expect(api).toContain('inList("status", [...LIVE_LEAVE_STATUSES])');
  });

  it("asks for the requests that overlap the range, both bounds", () => {
    expect(api).toContain('lte("from_date", to)');
    expect(api).toContain('gte("to_date", from)');
  });

  it("re-reads often enough to catch a booking made a minute ago", () => {
    const hook = hooks.slice(hooks.indexOf("export function useMyBookedLeave"));
    expect(hook.slice(0, hook.indexOf("\n}"))).toContain("staleTime: 30 * 1000");
  });
});

describe("the screen acts on it", () => {
  it("picks the free half for them, once", () => {
    expect(page).toContain("autoHalfDone");
    expect(page).toContain("if (autoHalfKey === \"\" || autoHalfDone.current === autoHalfKey) return;");
    expect(page).toContain("setHalfPortion(bookedAdvice.suggestPortion)");
  });

  it("keys the auto-pick on the date AND the half held, so a new date re-arms it", () => {
    expect(page).toContain("`${bookedAdvice.date}|${bookedAdvice.heldPortion}`");
  });

  it("stops the submit when the dates are spoken for", () => {
    expect(page).toContain("if (bookedAdvice.kind === \"blocked\") blockers.push(bookedAdviceText(bookedAdvice));");
    expect(page).toContain("bookedAdvice.kind === \"complement\" && !bookedAdvice.chosenIsFree");
  });

  it("offers the 0.5 shortcut instead of only explaining it", () => {
    expect(page).toContain('setTotalDays("0.5")');
    expect(page).toContain('t("leave.app.booked.makeItHalf")');
  });

  it("names the request that is in the way in every refusal", () => {
    for (const key of [
      "leave.app.blocked.dateFull",
      "leave.app.blocked.onlyHalfFree",
      "leave.app.blocked.rangeBooked",
    ]) {
      expect(read("src", "shared", "i18n", "keys", "leave-application.ts")).toContain(key);
    }
    const en = read("src", "shared", "i18n", "keys", "leave-application.ts");
    const block = en.slice(en.indexOf('"leave.app.blocked.dateFull"'));
    expect(block.slice(0, 600)).toContain("{number}");
  });

  it("resolves the blocking booking's type from ALL active types, not the allocatable ones", () => {
    expect(page).toContain("useLeaveTypeRules()");
    expect(page).toContain("(allTypes.data ?? []).find((rule) => rule.id === row.leave_type_id)");
  });
});
