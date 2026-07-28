/**
 * The shared analytics filter bar, asserted where it actually lives: the URL.
 *
 * The bar holds no state, so every one of its behaviours is a pure function from
 * (filters, event) to a query string. Three of them have a plausible-looking
 * wrong answer that a rendering test would only catch once somebody complained:
 *
 *   1. "Previous" on a custom range. Stepping a fortnight by a MONTH, or by a
 *      single day, both produce a chart that draws — and a comparison nobody can
 *      reproduce. It must step by the range's own length.
 *   2. "Clear filters" moving the dates. `clearDimensions` keeps the period by
 *      construction; the URL writer is where that guarantee can quietly be lost,
 *      because it rebuilds the whole query string. A user who clears a department
 *      and lands in a different month stops trusting every number on the page.
 *   3. Params the filter model does not own. A drill-through arrives carrying
 *      `?status=late`; if a period nudge drops it, the screen silently answers a
 *      different question from the tile that opened it.
 *
 * The clock is frozen, because "Today", "This month" and the future-stop on Next
 * are all defined against the IST civil date and a test that passes in July must
 * still pass in August.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { periodFor, type Granularity, type Period } from "@/lib/period";
import {
  clearDimensions,
  filtersFromParams,
  type AnalyticsFilters,
} from "@/lib/analyticsFilters";
import {
  canStepBack,
  canStepForward,
  filterParams,
  isAtPresent,
  periodLabel,
  resetFilters,
  steppedFilters,
  withDimension,
  withGranularity,
  withRangeEnd,
  withRangeStart,
  withSource,
} from "./analyticsFilterBar";

/** Wednesday 15 July 2026, 10:00 IST — mid-week, mid-month, mid-year. */
const FROZEN_IST = "2026-07-15T10:00:00+05:30";
const TODAY = "2026-07-15";

const DEPT = "11111111-1111-4111-8111-111111111111";
const LOC = "22222222-2222-4222-8222-222222222222";
const EMP = "33333333-3333-4333-8333-333333333333";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FROZEN_IST));
});

afterAll(() => {
  vi.useRealTimers();
});

function period(granularity: Granularity, from: string, to: string): Period {
  return { granularity, from, to };
}

function filters(p: Period, extra: Partial<AnalyticsFilters> = {}): AnalyticsFilters {
  return { period: p, source: "all", ...extra };
}

/** What the address bar would read after this transition. */
function url(next: AnalyticsFilters, current = ""): string {
  return filterParams(new URLSearchParams(current), next).toString();
}

/** The params object a screen would then parse back out. */
function roundTrip(next: AnalyticsFilters, current = ""): AnalyticsFilters {
  return filtersFromParams(filterParams(new URLSearchParams(current), next));
}

describe("the URL is the source of truth", () => {
  it("round-trips every field it writes", () => {
    const original = filters(period("range", "2026-06-01", "2026-06-14"), {
      departmentId: DEPT,
      locationId: LOC,
      employeeId: EMP,
      source: "kiosk_face",
    });
    expect(roundTrip(original)).toEqual(original);
  });

  it("keeps params it does not own", () => {
    // The drill-through's own question travels alongside the filter.
    const out = url(filters(periodFor("day", TODAY)), "status=late&tab=exceptions");
    const params = new URLSearchParams(out);
    expect(params.get("status")).toBe("late");
    expect(params.get("tab")).toBe("exceptions");
  });

  it("removes a dimension from the URL rather than blanking it", () => {
    // `?dept=` is not a uuid; PostgREST answers 400 and the screen shows an
    // error the user cannot act on. The key has to go, not go empty.
    const withDept = filters(periodFor("month", TODAY), { departmentId: DEPT });
    const cleared = withDimension(withDept, "departmentId", "");
    const params = new URLSearchParams(url(cleared, url(withDept)));
    expect(params.has("dept")).toBe(false);
    expect(cleared.departmentId).toBeUndefined();
  });
});

describe("granularity switch", () => {
  it("writes the day the user is standing on when today is inside the period", () => {
    const out = new URLSearchParams(url(withGranularity(filters(periodFor("month", TODAY)), "day")));
    expect(out.get("g")).toBe("day");
    expect(out.get("from")).toBe(TODAY);
    expect(out.get("to")).toBe(TODAY);
  });

  it("writes the first day of a historical period, not today", () => {
    // Narrowing March to a day must land in March. Jumping to July would throw
    // away the navigation the user just did.
    const march = filters(periodFor("month", "2026-03-09"));
    const out = new URLSearchParams(url(withGranularity(march, "day")));
    expect(out.get("from")).toBe("2026-03-01");
    expect(out.get("to")).toBe("2026-03-01");
  });

  it("writes Monday–Sunday for a week", () => {
    const out = new URLSearchParams(url(withGranularity(filters(periodFor("day", TODAY)), "week")));
    expect(out.get("g")).toBe("week");
    expect(out.get("from")).toBe("2026-07-13"); // Monday
    expect(out.get("to")).toBe("2026-07-19"); // Sunday
  });

  it("writes whole calendar bounds for a month and a year", () => {
    const month = new URLSearchParams(url(withGranularity(filters(periodFor("day", TODAY)), "month")));
    expect([month.get("from"), month.get("to")]).toEqual(["2026-07-01", "2026-07-31"]);

    const year = new URLSearchParams(url(withGranularity(filters(periodFor("day", TODAY)), "year")));
    expect([year.get("from"), year.get("to")]).toEqual(["2026-01-01", "2026-12-31"]);
  });

  it("carries both ends into Custom instead of collapsing to one day", () => {
    const out = new URLSearchParams(url(withGranularity(filters(periodFor("month", TODAY)), "range")));
    expect(out.get("g")).toBe("range");
    expect([out.get("from"), out.get("to")]).toEqual(["2026-07-01", "2026-07-31"]);
  });

  it("leaves the dimensions alone", () => {
    const narrowed = filters(periodFor("month", TODAY), { departmentId: DEPT, source: "web" });
    const switched = withGranularity(narrowed, "week");
    expect(switched.departmentId).toBe(DEPT);
    expect(switched.source).toBe("web");
  });
});

describe("prev / next step by exactly one period", () => {
  it("moves a day by a day", () => {
    const day = filters(periodFor("day", "2026-07-15"));
    expect(url(steppedFilters(day, -1))).toBe(url(filters(periodFor("day", "2026-07-14"))));
    expect(url(steppedFilters(day, 1))).toBe(url(filters(periodFor("day", "2026-07-16"))));
  });

  it("moves a week by seven days, staying Monday-anchored", () => {
    const week = filters(periodFor("week", "2026-07-15"));
    const back = new URLSearchParams(url(steppedFilters(week, -1)));
    expect([back.get("from"), back.get("to")]).toEqual(["2026-07-06", "2026-07-12"]);
    const forward = new URLSearchParams(url(steppedFilters(week, 1)));
    expect([forward.get("from"), forward.get("to")]).toEqual(["2026-07-20", "2026-07-26"]);
  });

  it("moves a month by a calendar month, across a year boundary", () => {
    const january = filters(periodFor("month", "2026-01-20"));
    const back = new URLSearchParams(url(steppedFilters(january, -1)));
    // 31 days, not 31 days back from the 1st — and December of the year before.
    expect([back.get("from"), back.get("to")]).toEqual(["2025-12-01", "2025-12-31"]);
  });

  it("lands on the real last day of a short month", () => {
    const march = filters(periodFor("month", "2026-03-31"));
    const back = new URLSearchParams(url(steppedFilters(march, -1)));
    expect([back.get("from"), back.get("to")]).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("moves a year by a year", () => {
    const out = new URLSearchParams(url(steppedFilters(filters(periodFor("year", TODAY)), -1)));
    expect([out.get("g"), out.get("from"), out.get("to")]).toEqual([
      "year",
      "2025-01-01",
      "2025-12-31",
    ]);
  });

  it("moves a custom range by its OWN length, not by a month", () => {
    // The fortnight before this fortnight — the only "previous" that keeps a
    // comparison like-for-like.
    const fortnight = filters(period("range", "2026-07-01", "2026-07-14"));
    const back = new URLSearchParams(url(steppedFilters(fortnight, -1)));
    expect([back.get("from"), back.get("to")]).toEqual(["2026-06-17", "2026-06-30"]);
    const forward = new URLSearchParams(url(steppedFilters(fortnight, 1)));
    expect([forward.get("from"), forward.get("to")]).toEqual(["2026-07-15", "2026-07-28"]);
  });

  it("stops going forward once the period reaches today", () => {
    // DR-30 in its calendar form: an empty August grid in July reads as an
    // outage, not as the future.
    expect(canStepForward(periodFor("month", TODAY))).toBe(false);
    expect(canStepForward(periodFor("day", TODAY))).toBe(false);
    expect(canStepForward(periodFor("year", TODAY))).toBe(false);
    expect(canStepForward(periodFor("day", "2026-07-14"))).toBe(true);
    expect(canStepForward(periodFor("month", "2026-06-10"))).toBe(true);
  });

  it("stops going back at the caller's earliest data", () => {
    expect(canStepBack(periodFor("month", "2026-01-10"), "2026-01-01")).toBe(false);
    expect(canStepBack(periodFor("month", "2026-02-10"), "2026-01-01")).toBe(true);
    expect(canStepBack(periodFor("month", "2020-02-10"))).toBe(true);
  });
});

describe("the reset button", () => {
  it("returns to the current period of the same granularity", () => {
    const old = filters(periodFor("month", "2025-11-04"));
    const out = new URLSearchParams(url(resetFilters(old)));
    expect([out.get("g"), out.get("from"), out.get("to")]).toEqual([
      "month",
      "2026-07-01",
      "2026-07-31",
    ]);
  });

  it("keeps a custom range's length and ends it today", () => {
    // "Ending today", not a one-day window still labelled Custom.
    const tenDays = filters(period("range", "2026-01-01", "2026-01-10"));
    const out = new URLSearchParams(url(resetFilters(tenDays)));
    expect([out.get("from"), out.get("to")]).toEqual(["2026-07-06", "2026-07-15"]);
  });

  it("does not touch the dimensions", () => {
    const narrowed = filters(periodFor("month", "2025-11-04"), {
      departmentId: DEPT,
      source: "web",
    });
    const reset = resetFilters(narrowed);
    expect(reset.departmentId).toBe(DEPT);
    expect(reset.source).toBe("web");
  });

  it("knows when it would do nothing, per granularity", () => {
    expect(isAtPresent(filters(periodFor("month", TODAY)))).toBe(true);
    expect(isAtPresent(filters(periodFor("day", TODAY)))).toBe(true);
    expect(isAtPresent(filters(periodFor("day", "2026-07-14")))).toBe(false);
    // A range is "at present" when it ENDS today, not when it merely contains it.
    expect(isAtPresent(filters(period("range", "2026-07-06", TODAY)))).toBe(true);
    expect(isAtPresent(filters(period("range", "2026-07-06", "2026-07-31")))).toBe(false);
  });
});

describe("custom range", () => {
  it("pushes the end forward rather than accepting an inverted range", () => {
    // An inverted range returns no rows, and "no data" is indistinguishable on
    // screen from a period in which genuinely nothing happened.
    const out = withRangeStart(filters(period("range", "2026-07-01", "2026-07-10")), "2026-07-20");
    expect([out.period.from, out.period.to]).toEqual(["2026-07-20", "2026-07-20"]);
  });

  it("pulls the start back rather than accepting an inverted range", () => {
    const out = withRangeEnd(filters(period("range", "2026-07-10", "2026-07-20")), "2026-07-02");
    expect([out.period.from, out.period.to]).toEqual(["2026-07-02", "2026-07-02"]);
  });

  it("keeps the other end when the edit is valid", () => {
    const base = filters(period("range", "2026-07-01", "2026-07-10"));
    expect(url(withRangeEnd(base, "2026-07-31"))).toBe(
      url(filters(period("range", "2026-07-01", "2026-07-31"))),
    );
  });

  it("ignores a cleared or malformed date instead of writing a broken URL", () => {
    const base = filters(period("range", "2026-07-01", "2026-07-10"));
    expect(withRangeStart(base, "")).toBe(base);
    expect(withRangeEnd(base, "2026-02-30")).toBe(base); // no such day
  });

  it("never writes an inverted range, whichever end was dragged", () => {
    const base = filters(period("range", "2026-07-05", "2026-07-06"));
    for (const value of ["2026-01-01", "2026-07-05", "2026-12-31"]) {
      for (const next of [withRangeStart(base, value), withRangeEnd(base, value)]) {
        expect(next.period.from <= next.period.to).toBe(true);
      }
    }
  });
});

describe("clearing dimensions never changes the dates", () => {
  it("drops every narrowing and leaves g/from/to byte-identical", () => {
    const narrowed = filters(period("range", "2026-02-03", "2026-02-17"), {
      departmentId: DEPT,
      locationId: LOC,
      employeeId: EMP,
      source: "kiosk_face",
    });
    const before = new URLSearchParams(url(narrowed));
    const after = new URLSearchParams(url(clearDimensions(narrowed), url(narrowed)));

    expect(after.get("g")).toBe(before.get("g"));
    expect(after.get("from")).toBe(before.get("from"));
    expect(after.get("to")).toBe(before.get("to"));
    expect([...after.keys()].sort()).toEqual(["from", "g", "to"]);
  });

  it("holds for every granularity", () => {
    const dimensions = { departmentId: DEPT, locationId: LOC, employeeId: EMP } as const;
    for (const granularity of ["day", "week", "month", "year"] as const) {
      const narrowed = filters(periodFor(granularity, "2025-09-11"), {
        ...dimensions,
        source: "web",
      });
      expect(clearDimensions(narrowed).period).toEqual(narrowed.period);
      expect(roundTrip(clearDimensions(narrowed)).period).toEqual(narrowed.period);
    }
  });

  it("survives the URL round trip with the period intact", () => {
    const narrowed = filters(periodFor("week", "2026-04-02"), { departmentId: DEPT });
    const reparsed = roundTrip(clearDimensions(narrowed), url(narrowed));
    expect(reparsed.period).toEqual(narrowed.period);
    expect(reparsed.departmentId).toBeUndefined();
    expect(reparsed.source).toBe("all");
  });

  it("takes the source back to `all`, which is written as no param at all", () => {
    const narrowed = filters(periodFor("month", TODAY), { source: "mobile" });
    expect(new URLSearchParams(url(narrowed)).get("src")).toBe("mobile");
    const cleared = new URLSearchParams(url(withSource(narrowed, "all"), url(narrowed)));
    expect(cleared.has("src")).toBe(false);
  });
});

describe("the period label", () => {
  it("names a month, a year and a day the way the rest of the product does", () => {
    expect(periodLabel(periodFor("month", "2026-07-15"))).toBe("July 2026");
    expect(periodLabel(periodFor("year", "2026-07-15"))).toBe("2026");
    // §8's one date format — '28-Jul-2026', not '28 Jul 2026'.
    expect(periodLabel(periodFor("day", "2026-07-28"))).toBe("28-Jul-2026");
  });

  it("shows both ends of a week and of a custom range", () => {
    expect(periodLabel(periodFor("week", "2026-07-15"))).toBe("13-Jul-2026 – 19-Jul-2026");
    expect(periodLabel(period("range", "2026-07-01", "2026-07-07"))).toBe(
      "01-Jul-2026 – 07-Jul-2026",
    );
    expect(periodLabel(period("range", "2026-07-07", "2026-07-07"))).toBe("07-Jul-2026");
  });

  it("describes the days actually queried when a URL claims a month it does not hold", () => {
    // `?g=month&from=2026-07-05&to=2026-07-20` is reachable by hand. Labelling
    // that "July 2026" over a grid holding sixteen days of it is a lie.
    expect(periodLabel(period("month", "2026-07-05", "2026-07-20"))).toBe(
      "05-Jul-2026 – 20-Jul-2026",
    );
  });
});
