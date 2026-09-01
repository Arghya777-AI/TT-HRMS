/**
 * The Worked column, exercised rather than grepped.
 *
 * Every case below is a real row from the venue's own board on 01 Sep 2026, because each of the
 * three bugs this file exists to prevent was found by somebody looking at that screen and not by
 * a test.
 */
import { describe, expect, it } from "vitest";
import { workedDisplay } from "./workedDisplay";

/** 01 Sep 2026, 10:30 IST — after the morning's scans, before anybody has gone home. */
const NOW = Date.parse("2026-09-01T10:30:00+05:30");
const iso = (hhmm: string) => `2026-09-01T${hhmm}:00+05:30`;

describe("somebody who scanned in and out", () => {
  it("shows the engine's credited minutes — Deepesh, 88 of them", () => {
    /*
      BUG 1. The engine recorded 88 minutes and called the day `absent`, correctly: 88 minutes
      does not earn a day. The column keyed off `attended`, which is false for `absent`, so it
      printed a dash against 1h 28m of real work.
    */
    const d = workedDisplay({
      workedMinutes: 88,
      firstInAt: iso("07:59"),
      lastOutAt: iso("09:28"),
      nowMs: NOW,
    });
    expect(d.kind).toBe("credited");
    expect(d.kind === "credited" && d.minutes).toBe(88);
    // Gone home: no ticking clock alongside.
    expect(d.kind === "credited" && d.alsoOnSite).toBeNull();
  });

  it("shows the SPAN when the engine credits nothing", () => {
    /*
      BUG 3, and the one that survived the first fix. Both scans are on the row and the engine
      credits 0 — a pair it has not processed, or has declined to credit. Printing a dash claims
      we do not know how long they were here, while the two times sit in the same row.
    */
    const d = workedDisplay({
      workedMinutes: 0,
      firstInAt: iso("07:59"),
      lastOutAt: iso("09:28"),
      nowMs: NOW,
    });
    expect(d.kind).toBe("span");
    // 89 minutes between the scans, and it is NOT presented as credited time.
    expect(d.kind === "span" && d.elapsed.hours).toBe(1);
    expect(d.kind === "span" && d.elapsed.minutes).toBe(29);
    expect(d.kind === "span" && d.elapsed.running).toBe(false);
  });
});

describe("somebody still on site", () => {
  it("ticks instead of showing 0h 00m", () => {
    /*
      BUG 2. `total_worked_minutes` counts COMPLETED intervals, so it is genuinely 0 for the 54
      people who had scanned in and not out. Right, and useless beside the word "Present".
    */
    const d = workedDisplay({
      workedMinutes: 0,
      firstInAt: iso("09:20"),
      lastOutAt: null,
      nowMs: NOW,
    });
    expect(d.kind).toBe("running");
    expect(d.kind === "running" && d.elapsed.running).toBe(true);
    expect(d.kind === "running" && d.elapsed.hours).toBe(1);
    expect(d.kind === "running" && d.elapsed.minutes).toBe(10);
  });

  it("keeps the engine's figure AND the clock when both apply", () => {
    // Out-scanned, credited, and back on site: the paid figure is settled, the clock is not.
    const d = workedDisplay({
      workedMinutes: 240,
      firstInAt: iso("06:00"),
      lastOutAt: null,
      nowMs: NOW,
    });
    expect(d.kind).toBe("credited");
    expect(d.kind === "credited" && d.alsoOnSite?.running).toBe(true);
  });
});

describe("the only case that shows nothing", () => {
  it("is somebody who never scanned", () => {
    const d = workedDisplay({
      workedMinutes: 0,
      firstInAt: null,
      lastOutAt: null,
      nowMs: NOW,
    });
    expect(d.kind).toBe("none");
  });

  it("is NOT somebody with a status the engine dislikes", () => {
    /*
      The whole family of bugs came from letting a status decide whether a duration existed.
      Nothing in this function reads a status, and these two rows prove it: identical times,
      and neither can be suppressed by whatever the engine called the day.
      */
    const withCredit = workedDisplay({
      workedMinutes: 88,
      firstInAt: iso("07:59"),
      lastOutAt: iso("09:28"),
      nowMs: NOW,
    });
    const withoutCredit = workedDisplay({
      workedMinutes: 0,
      firstInAt: iso("07:59"),
      lastOutAt: iso("09:28"),
      nowMs: NOW,
    });
    expect(withCredit.kind).not.toBe("none");
    expect(withoutCredit.kind).not.toBe("none");
  });
});

describe("a clock that would embarrass us", () => {
  it("does not run backwards on a skewed device clock", () => {
    // A punch recorded a few seconds ahead of the browser's idea of now. "-0h 00m 03s" on a
    // dashboard reads as a broken system; zero reads as "just arrived".
    const d = workedDisplay({
      workedMinutes: 0,
      firstInAt: iso("10:30"),
      lastOutAt: null,
      nowMs: NOW - 3_000,
    });
    expect(d.kind).toBe("running");
    expect(d.kind === "running" && d.elapsed.totalSeconds).toBe(0);
  });
});
