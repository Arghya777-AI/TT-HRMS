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

/** The 09:30–17:30 general shift most of the venue is on. */
/*
  THE REAL WIRE FORMAT. `shifts.start_time` and `end_time` are Postgres `time` columns and
  reach the client as "09:30:00". Fixtures written as "09:30" passed while production fell
  back to consecutive pairing on every row, because the shift never parsed — so the day
  fixture now carries seconds exactly as the database sends them.
*/
const DAY = { startTime: "09:30:00", endTime: "17:30:00" } as const;

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
    /*
      "09:40:12" is NOT in this list any more, and that is the fix rather than a relaxation:
      a shift's start_time and end_time are Postgres `time` columns and arrive with seconds.
      Rejecting them made `sessionsFromPunches` fall back to consecutive pairing on every row.
    */
    for (const bad of ["", "—", "9:4", "24:00", "09:60", "abc", "09:40:12:99"]) {
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
    expect(roster).toContain("sessionsFromPunches(punches, shift)");
    expect(roster).toContain("sessionTotals(sessions, workedMinutes)");
  });
});


/*
 * ── THE REGRESSION THIS RULE EXISTS FOR ──────────────────────────────────────
 * Consecutive pairing read Meghana's 08:30 · 12:20 · 12:40 · 17:32 as two sessions and called
 * the afternoon "extra", as though she had finished at lunchtime and come back. The shift
 * boundary is what separates her midday movement from Arghya's evening return, and these are
 * the two rows that must come out differently under the same rule.
 */
describe("the shift boundary decides what is a return", () => {
  it("keeps a day of midday movement as ONE session", () => {
    const sessions = sessionsFromPunches(at("08:30", "12:20", "12:40", "17:32"), {
      startTime: "09:00",
      endTime: "17:30",
    });
    expect(sessions).toHaveLength(1);
    const [only] = sessions;
    expect(only?.kind).toBe("shift");
    expect(only?.inPunch.at).toBe("08:30");
    expect(only?.outPunch?.at).toBe("17:32");
    expect(only?.minutes).toBe(542);
    /* The midday scans are kept and shown, not dropped. */
    expect(only?.within.map((w) => w.at)).toEqual(["12:20", "12:40"]);
  });

  it("still splits a genuine evening return", () => {
    const sessions = sessionsFromPunches(at("09:40", "17:30", "20:40", "21:45"), DAY);
    expect(sessions.map((s) => s.kind)).toEqual(["shift", "extra"]);
    expect(sessions[0]?.minutes).toBe(470);
    expect(sessions[1]?.inPunch.at).toBe("20:40");
    expect(sessions[1]?.minutes).toBe(65);
    /* The scan AT the shift end closes the shift; it is not swallowed. */
    expect(sessions[0]?.outPunch?.at).toBe("17:30");
    expect(sessions[0]?.within).toHaveLength(0);
  });

  it("does not turn an early arrival into an extra session", () => {
    const sessions = sessionsFromPunches(at("07:00", "17:35"), DAY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.kind).toBe("shift");
    expect(sessions[0]?.minutes).toBe(635);
  });

  it("reads a day that never reached the shift end as still open", () => {
    const sessions = sessionsFromPunches(at("09:30", "12:00", "12:30"), DAY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.outPunch).toBeNull();
    expect(sessions[0]?.minutes).toBeNull();
  });

  it("closes an early leaver at their last scan", () => {
    const sessions = sessionsFromPunches(at("09:30", "16:00"), DAY);
    expect(sessions[0]?.outPunch?.at).toBe("16:00");
    expect(sessions[0]?.minutes).toBe(390);
  });

  it("puts a whole evening call-out under extra, never under shift", () => {
    const sessions = sessionsFromPunches(at("19:00", "21:00"), DAY);
    expect(sessions.map((s) => s.kind)).toEqual(["extra"]);
    expect(sessions[0]?.minutes).toBe(120);
  });

  it("handles a night shift without calling the whole thing extra", () => {
    const night = { startTime: "19:00", endTime: "07:00" } as const;
    const sessions = sessionsFromPunches(at("18:50", "07:10"), night);
    expect(sessions.map((s) => s.kind)).toEqual(["shift"]);
    expect(sessions[0]?.minutes).toBe(740);
  });

  it("falls back to consecutive pairing when no shift is assigned", () => {
    const sessions = sessionsFromPunches(at("09:40", "17:30", "20:40", "21:45"), null);
    expect(sessions.map((s) => s.kind)).toEqual(["shift", "extra"]);
    expect(sessions[1]?.inPunch.at).toBe("20:40");
  });
});

describe("the breakdown reconciles with the engine's worked figure", () => {
  it("states the gap the engine holds off the clock", () => {
    const sessions = sessionsFromPunches(at("08:30", "12:20", "12:40", "17:32"), {
      startTime: "09:00",
      endTime: "17:30",
    });
    /* 9h 02m on site; the engine counts 8h 42m, so twenty minutes are off the clock. */
    const totals = sessionTotals(sessions, 522);
    expect(totals.totalMinutes).toBe(542);
    expect(totals.offClockMinutes).toBe(20);
    expect(totals.workedMinutes).toBe(522);
  });

  it("claims no deduction when the sessions already agree", () => {
    const sessions = sessionsFromPunches(at("09:40", "17:30", "20:40", "21:45"), DAY);
    const totals = sessionTotals(sessions, 535);
    expect(totals.offClockMinutes).toBe(0);
    expect(totals.shiftMinutes + totals.extraMinutes).toBe(535);
  });

  it("never reports a NEGATIVE break when the engine counts MORE than the scans show", () => {
    /* A regularised day carries minutes the scans cannot account for. That is not a break. */
    const sessions = sessionsFromPunches(at("09:30", "17:30"), DAY);
    const totals = sessionTotals(sessions, 600);
    expect(totals.offClockMinutes).toBe(0);
  });

  it("does not deduct against a running day", () => {
    const sessions = sessionsFromPunches(at("09:30"), DAY);
    const totals = sessionTotals(sessions, 0);
    expect(totals.open).toBe(true);
    expect(totals.offClockMinutes).toBe(0);
  });
});

describe("the shift window as the database actually sends it", () => {
  it("parses a Postgres time, seconds and all", () => {
    // THE REGRESSION THIS EXISTS FOR: "17:30:00" returned null and disabled the whole rule.
    expect(parseHm("17:30:00")).toBe(1050);
    expect(parseHm("09:30:00")).toBe(570);
    expect(parseHm("17:30")).toBe(1050);
    expect(parseHm("00:00:00")).toBe(0);
  });

  it("still refuses something that is not a time", () => {
    for (const bad of ["", "—", "24:00:00", "09:60:00", "9:4", "abc", "17:30:00:00"]) {
      expect(parseHm(bad), bad).toBeNull();
    }
  });

  it("keeps Meghana's day whole when the shift carries seconds", () => {
    /*
      The exact row from the dashboard: 08:30, 12:20, 12:40, 17:32 against 09:00:00-17:30:00.
      With the seconds rejected this split at lunch into "Shift 08:30-12:20, Extra
      12:40-17:32" — a sales manager finishing at lunchtime and starting a second day.
    */
    const sessions = sessionsFromPunches(at("08:30", "12:20", "12:40", "17:32"), {
      startTime: "09:00:00",
      endTime: "17:30:00",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.inPunch.at).toBe("08:30");
    expect(sessions[0]?.outPunch?.at).toBe("17:32");
    expect(sessions[0]?.within.map((w) => w.at)).toEqual(["12:20", "12:40"]);
  });

  it("keeps a housekeeper's lunch inside one session too", () => {
    // Ambresh, 123: 08:58, 13:04, 13:58, 17:32 on GRD 09:00:00-18:00:00.
    const sessions = sessionsFromPunches(at("08:58", "13:04", "13:58", "17:32"), {
      startTime: "09:00:00",
      endTime: "18:00:00",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.within.map((w) => w.at)).toEqual(["13:04", "13:58"]);
  });

  it("still splits a real evening return when the shift carries seconds", () => {
    const sessions = sessionsFromPunches(at("09:40", "17:30", "20:40", "21:45"), DAY);
    expect(sessions.map((s) => s.kind)).toEqual(["shift", "extra"]);
  });
});
