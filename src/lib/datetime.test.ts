import { describe, expect, it } from "vitest";
import {
  fmtCivilDate,
  fmtDate,
  fmtDateTime,
  fmtDayMonth,
  fmtDuration,
  fmtMonth,
  fmtTime,
  isSameIstDay,
  istDate,
  istDayUtcBounds,
} from "./datetime";

describe("IST business-date derivation (the core defect fix)", () => {
  it("files a post-midnight IST instant on the IST day, not the UTC day", () => {
    // 2026-07-24T20:30:00Z === 2026-07-25 02:00 IST (a wedding shift ending after midnight).
    const instant = "2026-07-24T20:30:00Z";
    expect(istDate(instant)).toBe("2026-07-25"); // UTC date would be 2026-07-24 — the bug we killed
    expect(fmtDate(instant)).toBe("25-Jul-2026");
    expect(fmtTime(instant)).toBe("02:00");
    expect(fmtDateTime(instant)).toBe("25-Jul-2026 02:00 IST");
  });

  it("rolls the year correctly across the UTC/IST new-year boundary", () => {
    // 2025-12-31T19:00:00Z === 2026-01-01 00:30 IST
    const instant = "2025-12-31T19:00:00Z";
    expect(istDate(instant)).toBe("2026-01-01"); // UTC date & year would both be wrong
    expect(fmtMonth(instant)).toBe("Jan-2026");
  });

  it("formats a normal daytime instant", () => {
    const instant = "2026-07-25T03:35:00Z"; // 09:05 IST
    expect(fmtDateTime(instant)).toBe("25-Jul-2026 09:05 IST");
    expect(fmtMonth(instant)).toBe("Jul-2026");
    expect(fmtDayMonth(instant)).toBe("25-Jul");
  });

  it("isSameIstDay compares IST civil dates", () => {
    expect(isSameIstDay("2026-07-24T20:30:00Z", "2026-07-25T10:00:00Z")).toBe(true);
    expect(isSameIstDay("2026-07-24T17:00:00Z", "2026-07-24T20:30:00Z")).toBe(false); // 22:30 vs 02:00(+1)
  });

  it("computes exact UTC bounds for an IST civil date", () => {
    const { startUtc, endUtc } = istDayUtcBounds("2026-07-25");
    expect(startUtc.toISOString()).toBe("2026-07-24T18:30:00.000Z"); // 25th 00:00 IST
    expect(endUtc.toISOString()).toBe("2026-07-25T18:30:00.000Z");
  });
});

describe("civil date strings are not reinterpreted through a timezone", () => {
  it("formats a plain 'YYYY-MM-DD' as-is", () => {
    expect(fmtCivilDate("2026-01-05")).toBe("05-Jan-2026");
    expect(fmtCivilDate("2026-12-31")).toBe("31-Dec-2026");
    expect(fmtCivilDate(null)).toBe("—");
    expect(fmtCivilDate("garbage")).toBe("—");
  });
});

describe("fmtDuration renders h:mm, never decimal hours", () => {
  it("formats minutes", () => {
    expect(fmtDuration(529)).toBe("8:49");
    expect(fmtDuration(540)).toBe("9:00");
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(5)).toBe("0:05");
    expect(fmtDuration(-15)).toBe("-0:15");
  });
  it("renders unknown durations as an em dash, never 0", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
  });
});
