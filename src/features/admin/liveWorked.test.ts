/**
 * Tests for the on-site clock.
 *
 * `now` is an argument rather than something the module reads, so a ticking clock can be tested
 * by advancing a value instead of waiting for real seconds to pass.
 */
import { describe, expect, it } from "vitest";
import { elapsedOnSite, formatElapsed } from "./liveWorked";

const at = (iso: string): number => Date.parse(iso);

describe("elapsedOnSite", () => {
  it("counts from the first scan to now while somebody is still in", () => {
    // Scanned in at 10:23, somebody looks at the screen at 11:24:01.
    const e = elapsedOnSite({
      firstInAt: "2026-08-06T10:23:00+05:30",
      lastOutAt: null,
      nowMs: at("2026-08-06T11:24:01+05:30"),
      isLive: true,
    });
    expect(e.hours).toBe(1);
    expect(e.minutes).toBe(1);
    expect(e.seconds).toBe(1);
    expect(e.running).toBe(true);
  });

  it("keeps ticking second by second", () => {
    const base = {
      firstInAt: "2026-08-06T10:00:00+05:30",
      lastOutAt: null,
      isLive: true,
    } as const;
    const a = elapsedOnSite({ ...base, nowMs: at("2026-08-06T10:00:05+05:30") });
    const b = elapsedOnSite({ ...base, nowMs: at("2026-08-06T10:00:06+05:30") });
    expect(b.totalSeconds - a.totalSeconds).toBe(1);
  });

  it("counts break time, because that is what on-site means", () => {
    // An hour of it spent at lunch: the wall clock does not care.
    const e = elapsedOnSite({
      firstInAt: "2026-08-06T09:00:00+05:30",
      lastOutAt: null,
      nowMs: at("2026-08-06T18:00:00+05:30"),
      isLive: true,
    });
    expect(e.hours).toBe(9);
  });

  it("STOPS once they have scanned out", () => {
    // A clock still running at midnight on somebody who left at 18:30 is a bug.
    const e = elapsedOnSite({
      firstInAt: "2026-08-06T09:30:00+05:30",
      lastOutAt: "2026-08-06T18:30:00+05:30",
      nowMs: at("2026-08-07T00:00:00+05:30"),
      isLive: true,
    });
    expect(e.hours).toBe(9);
    expect(e.minutes).toBe(0);
    expect(e.running).toBe(false);
  });

  it("never ticks on a historical row", () => {
    const e = elapsedOnSite({
      firstInAt: "2026-07-01T09:00:00+05:30",
      lastOutAt: "2026-07-01T17:00:00+05:30",
      nowMs: at("2026-08-06T12:00:00+05:30"),
      isLive: false,
    });
    expect(e.running).toBe(false);
    expect(e.hours).toBe(8);
  });

  it("is nothing when they have not scanned at all", () => {
    const e = elapsedOnSite({
      firstInAt: null,
      lastOutAt: null,
      nowMs: at("2026-08-06T12:00:00+05:30"),
      isLive: true,
    });
    expect(e.totalSeconds).toBe(0);
    expect(e.running).toBe(false);
    expect(formatElapsed(e)).toBe("—");
  });

  it("clamps a scan that is ahead of the browser's clock to zero", () => {
    // Real: a device with a skewed clock. "-0h 00m 03s" reads as a broken dashboard.
    const e = elapsedOnSite({
      firstInAt: "2026-08-06T12:00:03+05:30",
      lastOutAt: null,
      nowMs: at("2026-08-06T12:00:00+05:30"),
      isLive: true,
    });
    expect(e.totalSeconds).toBe(0);
  });

  it("survives an unparseable timestamp instead of rendering NaN", () => {
    const e = elapsedOnSite({
      firstInAt: "not a date",
      lastOutAt: null,
      nowMs: at("2026-08-06T12:00:00+05:30"),
      isLive: true,
    });
    expect(e.totalSeconds).toBe(0);
  });
});

describe("formatElapsed", () => {
  it("shows hours only once there is one", () => {
    expect(formatElapsed({ hours: 0, minutes: 4, seconds: 9, totalSeconds: 249, running: true }))
      .toBe("04m 09s");
    expect(formatElapsed({ hours: 1, minutes: 4, seconds: 9, totalSeconds: 3849, running: true }))
      .toBe("1h 04m 09s");
  });

  it("pads, so the number does not jitter as the seconds roll over", () => {
    expect(formatElapsed({ hours: 2, minutes: 0, seconds: 5, totalSeconds: 7205, running: true }))
      .toBe("2h 00m 05s");
  });
});
