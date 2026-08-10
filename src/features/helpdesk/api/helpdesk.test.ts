/**
 * The two pure decisions in the ticket queue.
 *
 * Both exist because the alternative is a stored boolean. `is_breached` as a
 * column would be true only until someone moved the deadline, and then it would
 * be a fact about the past claiming to be a fact about now.
 */
import { describe, expect, it } from "vitest";
import { canReply, isBreached } from "./helpdesk.api";

const DUE = "2026-08-10T12:00:00+05:30";
const at = (iso: string): number => Date.parse(iso);

describe("isBreached", () => {
  it("is false when there is no deadline at all", () => {
    // A ticket raised before the settings existed carries NULLs, and a missing
    // promise is not a broken one.
    expect(isBreached(null, null, at("2030-01-01T00:00:00+05:30"))).toBe(false);
  });

  it("is false while the clock is still running", () => {
    expect(isBreached(DUE, null, at("2026-08-10T11:59:00+05:30"))).toBe(false);
  });

  it("is true once the deadline passes unmet", () => {
    expect(isBreached(DUE, null, at("2026-08-10T12:01:00+05:30"))).toBe(true);
  });

  it("judges a met promise on when it was met, not on now", () => {
    // The desk replied at 11:00 and it is now next year. Still on time.
    const met = "2026-08-10T11:00:00+05:30";
    expect(isBreached(DUE, met, at("2027-01-01T00:00:00+05:30"))).toBe(false);
  });

  it("stays breached when the reply came late, however long ago", () => {
    const met = "2026-08-10T18:00:00+05:30";
    expect(isBreached(DUE, met, at("2026-08-10T18:00:01+05:30"))).toBe(true);
  });

  it("treats the exact deadline as met, not missed", () => {
    expect(isBreached(DUE, DUE, at("2026-08-11T00:00:00+05:30"))).toBe(false);
    expect(isBreached(DUE, null, at(DUE))).toBe(false);
  });
});

describe("canReply", () => {
  it("allows a reply while the ticket is live", () => {
    for (const s of ["open", "in_progress", "waiting_on_requester", "resolved"]) {
      expect(canReply(s)).toBe(true);
    }
  });

  it("refuses one on a finished ticket", () => {
    // Mirrors hdm__participant__insert: reopen it first, which is recorded.
    expect(canReply("closed")).toBe(false);
    expect(canReply("cancelled")).toBe(false);
  });
});
