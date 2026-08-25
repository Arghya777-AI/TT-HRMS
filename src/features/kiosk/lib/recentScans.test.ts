/**
 * The gate tail. Both negative cases here were observed at a real gate, on one screenshot:
 * the same person, the same second, twice.
 */
import { describe, expect, it } from "vitest";

import { appendRecentScan, type RecentScanEntry } from "./recentScans";

const LIMIT = 5;
const row = (over: Partial<RecentScanEntry> = {}): RecentScanEntry => ({
  id: "row-1",
  displayName: "Vinod Maurya",
  employeeCode: "E-1001",
  punchKind: "in",
  istTime: "12:33:59",
  ...over,
});

describe("a scan that recorded nothing never becomes a row", () => {
  it("ignores a suppressed re-scan, leaving the original punch alone on the list", () => {
    const prev = [row()];
    const next = appendRecentScan(
      prev,
      {
        matched: true,
        duplicateSuppressed: true,
        displayName: "Vinod Maurya",
        employeeCode: "E-1001",
        punchKind: "in",
        // The server answers a suppressed scan from the ORIGINAL punch, which is exactly
        // why appending it produced two rows reading the same second.
        istTime: "12:33:59",
      },
      "row-2",
      LIMIT,
    );
    expect(next).toHaveLength(1);
    expect(next).toBe(prev); // same reference — nothing re-renders
  });

  it("ignores a suppressed scan even when the tail is empty", () => {
    // No punch was written, so there is nothing to show, however bare the list looks.
    const next = appendRecentScan([], { matched: true, duplicateSuppressed: true }, "row-1", LIMIT);
    expect(next).toEqual([]);
  });

  it("ignores a scan that matched nobody", () => {
    expect(appendRecentScan([], { matched: false }, "row-1", LIMIT)).toEqual([]);
  });
});

describe("one punch is one row", () => {
  it("drops a second genuine answer describing the punch already listed", () => {
    // Two captures in flight: both unsuppressed, both truthfully about the same punch.
    const prev = [row()];
    const next = appendRecentScan(
      prev,
      { matched: true, employeeCode: "E-1001", istTime: "12:33:59", punchKind: "in" },
      "row-2",
      LIMIT,
    );
    expect(next).toBe(prev);
  });

  it("still lists the same person's later punch", () => {
    const next = appendRecentScan(
      [row()],
      { matched: true, displayName: "Vinod Maurya", employeeCode: "E-1001", istTime: "18:02:11", punchKind: "out" },
      "row-2",
      LIMIT,
    );
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: "row-2", istTime: "18:02:11", punchKind: "out" });
  });

  it("does not collapse two different people who share an instant", () => {
    const next = appendRecentScan(
      [row()],
      { matched: true, displayName: "Ram Patel", employeeCode: "E-1002", istTime: "12:33:59", punchKind: "in" },
      "row-2",
      LIMIT,
    );
    expect(next).toHaveLength(2);
  });

  it("does not collapse unidentified rows into one another", () => {
    // An empty code is not evidence of sameness, so it must never match another empty code.
    const blank = [row({ id: "row-1", employeeCode: "", istTime: "" })];
    const next = appendRecentScan(blank, { matched: true, employeeCode: "", istTime: "" }, "row-2", LIMIT);
    expect(next).toHaveLength(2);
  });
});

describe("the tail stays short and newest-first", () => {
  it("keeps only the most recent `limit` rows", () => {
    let list: readonly RecentScanEntry[] = [];
    for (let i = 0; i < 8; i += 1) {
      list = appendRecentScan(
        list,
        { matched: true, employeeCode: `E-${i}`, istTime: `12:0${i}:00`, punchKind: "in" },
        `row-${i}`,
        LIMIT,
      );
    }
    expect(list).toHaveLength(LIMIT);
    expect(list[0]?.id).toBe("row-7");
  });
});
