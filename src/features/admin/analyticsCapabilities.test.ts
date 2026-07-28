/**
 * analyticsCapabilities.test.ts — the three-way distinction is the whole mechanism, so
 * it is the thing worth testing.
 *
 * "Never built" and "built but empty" look identical on a dashboard that only knows
 * empty-versus-not, and they send you to two different teams. If `resolveMetricState`
 * ever collapses them, every planned metric silently starts lying about why it is blank
 * — and nothing else in the app would notice.
 */
import { describe, expect, it } from "vitest";
import {
  PLANNED_METRICS,
  isSelfResolving,
  plannedMetric,
  plannedMetricsFor,
  resolveMetricState,
} from "./analyticsCapabilities";

describe("planned-metric state resolution", () => {
  it("calls a missing relation 'planned', not 'awaiting'", () => {
    // The table does not exist: nobody has built this. Different conversation from
    // "built but nobody has typed anything in".
    expect(resolveMetricState({ relationExists: false, rowCount: 0 })).toBe("planned");
  });

  it("calls an existing but empty relation 'awaiting'", () => {
    expect(resolveMetricState({ relationExists: true, rowCount: 0 })).toBe("awaiting");
  });

  it("goes live the moment there is a single row", () => {
    // No threshold, no flag to flip by hand — one row is data.
    expect(resolveMetricState({ relationExists: true, rowCount: 1 })).toBe("live");
  });

  it("never reports 'live' for a relation that does not exist, whatever the count", () => {
    // Defends against a future refactor that reads rowCount first.
    expect(resolveMetricState({ relationExists: false, rowCount: 999 })).toBe("planned");
  });
});

describe("the registry is a usable contract, not a wish list", () => {
  it("declares every metric the catalogue says is missing", () => {
    const keys = PLANNED_METRICS.map((m) => m.key);
    for (const expected of [
      "open_positions",
      "time_to_hire",
      "offer_acceptance",
      "performance_rating",
      "goal_attainment",
      "engagement_score",
      "enps",
      "pay_equity",
      "training_completion",
    ]) {
      expect(keys, `${expected} missing from the registry`).toContain(expected);
    }
  });

  it("gives every metric the columns it will read", () => {
    // `expects` is the contract handed to whoever builds the table. An empty one makes
    // the registry decorative.
    for (const m of PLANNED_METRICS) {
      expect(m.expects.length, `${m.key} declares no columns`).toBeGreaterThan(0);
      expect(m.enabledBy.length, `${m.key} does not say what switches it on`).toBeGreaterThan(20);
      expect(m.question.endsWith("?"), `${m.key}.question should be a question`).toBe(true);
    }
  });

  it("has unique keys, since they become query keys", () => {
    const keys = PLANNED_METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("marks a multi-relation metric as NOT self-resolving", () => {
    /*
      Pay equity needs salary BANDS as well as the grades and salaries we already hold,
      so probing one relation could never answer it. Saying so beats a probe that
      silently always fails and leaves the card stuck with no explanation.
    */
    const equity = plannedMetric("pay_equity");
    expect(equity).toBeDefined();
    expect(equity?.relation).toBeNull();
    expect(equity === undefined ? true : isSelfResolving(equity)).toBe(false);
  });

  it("marks the single-relation metrics as self-resolving, so they light up alone", () => {
    const positions = plannedMetric("open_positions");
    expect(positions).toBeDefined();
    expect(positions === undefined ? false : isSelfResolving(positions)).toBe(true);
  });

  it("groups by category for the dashboard sections", () => {
    expect(plannedMetricsFor("recruitment").length).toBeGreaterThanOrEqual(3);
    expect(plannedMetricsFor("engagement").length).toBeGreaterThanOrEqual(2);
  });

  it("does not claim attendance data can rate performance", () => {
    // The one place a placeholder could actively mislead: implying the system has
    // judged someone's work when all it has measured is punctuality.
    const rating = plannedMetric("performance_rating");
    expect(rating?.enabledBy).toMatch(/ATTENDANCE performance/);
  });
});
