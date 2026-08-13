/**
 * The two rules a chart in this app must never break.
 *
 *  1. ABSENT IS NOT ZERO. A day with no attendance record is not a day with zero
 *     hours, and a bar of height nothing says the second thing. An employee
 *     reading "absent" where the truth is "not processed yet" raises a ticket,
 *     and HR spends an afternoon on a rendering choice.
 *
 *  2. A CHART NEVER COMPUTES. Every figure is one the server produced. These
 *     components take values and paint them; there is no arithmetic to test
 *     because there is deliberately none to do.
 *
 * The colour mapping is asserted too, because a bar that disagrees with the
 * status badge beside it is worse than no bar — the reader has to hold two
 * mappings at once and will trust the wrong one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHART_TONE, seriesColor, CHART_SERIES } from "./chartTokens";
import { ProgressRing } from "./ProgressRing";
import { SplitBar } from "./SplitBar";

describe("chart tokens", () => {
  it("wraps the categorical ramp instead of running out of colours", () => {
    expect(seriesColor(0)).toBe(CHART_SERIES[0]);
    expect(seriesColor(CHART_SERIES.length)).toBe(CHART_SERIES[0]);
    expect(seriesColor(CHART_SERIES.length + 2)).toBe(CHART_SERIES[2]);
  });

  it("binds meaning to the same tokens the status chips use", () => {
    // If these drift, a green bar sits beside a red badge for one fact.
    expect(CHART_TONE.present).toContain("--success");
    expect(CHART_TONE.absent).toContain("--destructive");
    expect(CHART_TONE.leave).toContain("--info");
    expect(CHART_TONE.late).toContain("--warning");
    expect(CHART_TONE.earning).toBe(CHART_TONE.present);
    expect(CHART_TONE.deduction).toBe(CHART_TONE.absent);
  });
});

describe("ProgressRing", () => {
  it("draws nothing when there is no total to be a fraction of", () => {
    const { container } = render(
      <ProgressRing value={3} total={null} centre="3" caption="taken" title="Earned leave" />,
    );
    const arc = container.querySelectorAll("circle")[1];
    // A full or empty ring would both be claims about a ratio nobody supplied.
    expect(arc?.getAttribute("stroke-dasharray")?.startsWith("0 ")).toBe(true);
  });

  it("clamps the DRAWING past full but not the caption", () => {
    /*
      12 taken against 10 entitled is an overdraft, and the numbers must say so.
      An over-drawn ring just reads as a rendering bug.
    */
    const { container } = render(
      <ProgressRing value={12} total={10} centre="12" caption="of 10 days used" title="Sick" />,
    );
    const arc = container.querySelectorAll("circle")[1];
    const [drawn = "0", gap = "0"] = (arc?.getAttribute("stroke-dasharray") ?? "").split(" ");
    expect(Number(gap)).toBeCloseTo(0, 5);
    expect(Number(drawn)).toBeGreaterThan(0);
    expect(screen.getByText("of 10 days used")).toBeInTheDocument();
  });

  it("names the figure for a screen reader", () => {
    render(
      <ProgressRing value={3} total={12} centre="3" caption="of 12 days" title="Earned leave" />,
    );
    expect(screen.getByRole("img", { name: /Earned leave/ })).toBeInTheDocument();
  });
});

describe("SplitBar", () => {
  it("renders an empty track rather than a full bar when everything is zero", () => {
    const { container } = render(
      <SplitBar
        title="This month"
        segments={[
          { key: "p", label: "Present", value: 0, tone: "present" },
          { key: "a", label: "Absent", value: 0, tone: "absent" },
        ]}
      />,
    );
    // No segment at all: a zero total divided into parts is not a shape.
    expect(container.querySelectorAll("[title]").length).toBe(0);
  });

  it("drops a negative rather than drawing it backwards", () => {
    const { container } = render(
      <SplitBar
        title="This month"
        segments={[
          { key: "p", label: "Present", value: 18, tone: "present" },
          { key: "x", label: "Broken", value: -4, tone: "absent" },
        ]}
      />,
    );
    const drawn = container.querySelectorAll("[title]");
    expect(drawn.length).toBe(1);
    expect(drawn[0]?.getAttribute("title")).toContain("Present");
  });

  it("gives every segment a hover label with its own figure", () => {
    const { container } = render(
      <SplitBar
        title="Pay"
        format={(v) => `${String(v)} days`}
        segments={[
          { key: "p", label: "Present", value: 18, tone: "present" },
          { key: "l", label: "Leave", value: 2, tone: "leave" },
        ]}
      />,
    );
    const titles = [...container.querySelectorAll("[title]")].map((n) => n.getAttribute("title"));
    expect(titles).toContain("Present: 18 days");
    expect(titles).toContain("Leave: 2 days");
  });

  it("describes the whole split to assistive tech in one sentence", () => {
    render(
      <SplitBar
        title="This month"
        segments={[{ key: "p", label: "Present", value: 18, tone: "present" }]}
      />,
    );
    expect(screen.getByRole("img", { name: /This month: Present 18/ })).toBeInTheDocument();
  });
});
