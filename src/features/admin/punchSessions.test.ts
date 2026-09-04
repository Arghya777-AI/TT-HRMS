/**
 * Pairing a day's scans into sessions, and the arithmetic shown beside them.
 *
 * ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
 * The roster showed a flat row of chips — 09:40, 17:30, 20:40, 21:45 — beside a worked total
 * of 8h 55m, and left the reader to work out which scan was an arrival, which a departure,
 * and which pair was the shift as against somebody coming back at night. It could not answer
 * the obvious question, which is how those hours were made up.
 *
 * ── THE RULE, AS THE VENUE STATES IT ─────────────────────────────────────────
 * Scans pair in the order they were taken. So a punch-in BEFORE the shift starts is still
 * just the day's one punch-in — being early does not open an extra session — the punch-out
 * that closes that pair is the day's out, and a further punch-in after it opens a post-work
 * session under the same rule.
 *
 * Classification is by POSITION, never by clock. Somebody who starts at 07:00 against a 09:30
 * shift is early, not working two sessions, and a rule that compared times would cut their day
 * in half. That is the mistake this file exists to prevent.
 *
 * The pairing is the same one `compute_attendance_day` uses, so the breakdown adds up to the
 * engine's own worked figure in the next column rather than being a second opinion about it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minutesBetween, parseHm, sessionsFromPunches, sessionTotals } from "./punchSessions";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const roster = strip(read("src", "features", "admin", "components", "TodayRoster.tsx"));

const at = (...times: string[]) => times.map((t) => ({ at: t }));

describe("reading a wall clock", () => {
  it("parses an IST time to minutes", () => {
    expect(parseHm("09:40")).toBe(580);
    expect(parseHm("00:00")).toBe(0);
    expect(parseHm("23:59")).toBe(1439);
  });

  it("refuses anything that is not one", () => {
    for (const bad of ["", "—", "9:4", "24:00", "09:60", "abc", "09:40:12"]) {
      expect(parseHm(bad), bad).toBeNull();
    }
  });

  it("measures a pair inside one day", () => {
    expect(minutesBetween("09:40", "17:30")).toBe(470);
    expect(minutesBetween("20:40", "21:45")).toBe(65);
  });

  it("lets a session cross midnight rather than going negative", () => {
    /*
      A night session opening at 22:10 and closing at 02:30 is 4h 20m, not minus nineteen
      hours. Guards at this venue work exactly that shape.
    */
    expect(minutesBetween("22:10", "02:30")).toBe(260);
    expect(minutesBetween("23:59", "00:00")).toBe(1);
  });
});

describe("the day from the screenshot", () => {
  const sessions = sessionsFromPunches(at("09:40", "17:30", "20:40", "21:45"));

  it("makes two sessions, not four scans", () => {
    expect(sessions).toHaveLength(2);
  });

  it("calls the first pair the shift and the second extra", () => {
    expect(sessions[0]?.kind).toBe("shift");
    expect(sessions[1]?.kind).toBe("extra");
  });

  it("pairs each in with its own out", () => {
    expect(sessions[0]?.inPunch.at).toBe("09:40");
    expect(sessions[0]?.outPunch?.at).toBe("17:30");
    expect(sessions[1]?.inPunch.at).toBe("20:40");
    expect(sessions[1]?.outPunch?.at).toBe("21:45");
  });

  it("adds up to the worked total the engine computed", () => {
    // 7h 50m + 1h 05m = 8h 55m, which is the 535 minutes in the row beside it.
    const totals = sessionTotals(sessions);
    expect(totals.shiftMinutes).toBe(470);
    expect(totals.extraMinutes).toBe(65);
    expect(totals.totalMinutes).toBe(535);
    expect(totals.shiftMinutes + totals.extraMinutes).toBe(totals.totalMinutes);
    expect(totals.hasExtra).toBe(true);
    expect(totals.open).toBe(false);
  });
});

describe("early is not extra", () => {
  it("keeps a pre-shift arrival as the ONE punch-in of the shift session", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. 07:00 against a 09:30 shift is early. Classifying by
      clock would call 07:00-09:30 one session and 09:30 onward another, splitting a single
      day's work into a fiction.
    */
    const sessions = sessionsFromPunches(at("07:00", "18:52"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.kind).toBe("shift");
    expect(sessionTotals(sessions).extraMinutes).toBe(0);
    expect(sessionTotals(sessions).hasExtra).toBe(false);
  });

  it("only a RETURN after the out makes a second session", () => {
    const sessions = sessionsFromPunches(at("07:00", "18:52", "20:40", "21:45"));
    expect(sessions.map((s) => s.kind)).toEqual(["shift", "extra"]);
  });

  it("counts a third session as extra too, not as a new shift", () => {
    const sessions = sessionsFromPunches(at("09:00", "13:00", "14:00", "17:00", "20:00", "21:00"));
    expect(sessions.map((s) => s.kind)).toEqual(["shift", "extra", "extra"]);
    const totals = sessionTotals(sessions);
    expect(totals.shiftMinutes).toBe(240);          // 09:00-13:00
    expect(totals.extraMinutes).toBe(180 + 60);     // 14:00-17:00 and 20:00-21:00
    expect(totals.totalMinutes).toBe(480);          // and the sum is the sum
    expect(totals.shiftMinutes + totals.extraMinutes).toBe(totals.totalMinutes);
  });
});

describe("somebody still inside", () => {
  it("leaves the open pair without a duration rather than guessing one", () => {
    const sessions = sessionsFromPunches(at("09:40"));
    expect(sessions[0]?.outPunch).toBeNull();
    expect(sessions[0]?.minutes).toBeNull();
    expect(sessionTotals(sessions).open).toBe(true);
    expect(sessionTotals(sessions).totalMinutes).toBe(0);
  });

  it("still totals the sessions that DID close", () => {
    // Closed shift, then came back and has not left: 7h 50m counted, the evening still running.
    const totals = sessionTotals(sessionsFromPunches(at("09:40", "17:30", "20:40")));
    expect(totals.shiftMinutes).toBe(470);
    expect(totals.extraMinutes).toBe(0);
    expect(totals.open).toBe(true);
    expect(totals.hasExtra).toBe(true);
  });

  it("handles a day with no scans at all", () => {
    expect(sessionsFromPunches([])).toEqual([]);
    expect(sessionTotals([]).totalMinutes).toBe(0);
  });
});

describe("what the cell renders", () => {
  it("labels In and Out as their own columns", () => {
    expect(roster).toContain('t("admin.roster.sess.in")');
    expect(roster).toContain('t("admin.roster.sess.out")');
  });

  it("names each session rather than leaving the reader to infer it", () => {
    expect(roster).toContain('"admin.roster.sess.extra" : "admin.roster.sess.shift"');
  });

  it("writes the sum out as an addition", () => {
    /*
      Asked for in these words: "in the total duration also, it should look like this plus
      this is equal to this".
    */
    expect(roster).toContain("{fmtDurationHm(totals.shiftMinutes)}");
    expect(roster).toContain("{fmtDurationHm(totals.extraMinutes)}");
    expect(roster).toContain("{fmtDurationHm(totals.totalMinutes)}");
    expect(roster).toMatch(/>\+</);
    expect(roster).toMatch(/>=</);
  });

  it("shows the sum only when there is a second session to explain", () => {
    // "7h 50m = 7h 50m" on every ordinary row would be noise.
    expect(roster).toContain("{totals.hasExtra ? (");
  });

  it("keeps every scan's evidence on the time itself", () => {
    // The gate/web icon, the distance on a web punch, and the awaiting-approval star.
    expect(roster).toContain("admin.roster.loc.viaWeb");
    expect(roster).toContain("admin.roster.loc.awaiting");
    expect(roster).toContain("openStreetMapUrl");
  });

  it("derives the sessions rather than re-pairing them inline", () => {
    expect(roster).toContain("sessionsFromPunches(punches)");
    expect(roster).toContain("sessionTotals(sessions)");
  });
});
