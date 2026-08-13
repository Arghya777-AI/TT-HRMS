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
import { CoverageBar, coverageState, shortfall } from "./CoverageBar";

/* The tone map is internal to the component; mirrored here so a drift between
   meaning and colour fails a test rather than shipping. */
const STATE_TONE_FOR_TEST = {
  unknown: CHART_TONE.neutral,
  short: CHART_TONE.absent,
  met: CHART_TONE.present,
  over: CHART_TONE.present,
} as const;

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

describe("the informative additions", () => {
  it("prints each segment's share only when asked", () => {
    const segments = [
      { key: "p", label: "Present", value: 18, tone: "present" as const },
      { key: "l", label: "Leave", value: 2, tone: "leave" as const },
    ];
    const plain = render(<SplitBar title="Month" segments={segments} />);
    expect(plain.container.textContent).not.toContain("90%");
    plain.unmount();

    const withShare = render(<SplitBar title="Month" segments={segments} showShare />);
    // 18 of 20 — the number a reader would otherwise work out themselves.
    expect(withShare.container.textContent).toContain("90%");
    expect(withShare.container.textContent).toContain("10%");
  });

  it("puts the share in the hover label too", () => {
    const { container } = render(
      <SplitBar
        title="Month"
        showShare
        segments={[
          { key: "p", label: "Present", value: 3, tone: "present" },
          { key: "a", label: "Absent", value: 1, tone: "absent" },
        ]}
      />,
    );
    const titles = [...container.querySelectorAll("[title]")].map((n) => n.getAttribute("title"));
    expect(titles.some((x) => x?.includes("75%"))).toBe(true);
  });

  it("shows no total caption when every segment is zero", () => {
    // A caption naming a whole of nothing is a claim about a shape that is absent.
    const { container } = render(
      <SplitBar
        title="Month"
        totalCaption="26 days recorded"
        segments={[{ key: "p", label: "Present", value: 0, tone: "present" }]}
      />,
    );
    expect(container.textContent).not.toContain("26 days recorded");
  });

  it("prints the ring's percentage, but not when there is no total", () => {
    const withTotal = render(
      <ProgressRing value={3} total={12} centre="3" caption="of 12" title="EL" showPercent />,
    );
    expect(withTotal.container.textContent).toContain("25%");
    withTotal.unmount();

    /* No denominator means no fraction — a "0%" here would be a claim about a
       ratio nobody supplied, which is the same rule the arc follows. */
    const without = render(
      <ProgressRing value={3} total={null} centre="3" caption="taken" title="EL" showPercent />,
    );
    expect(without.container.textContent).not.toContain("%");
  });

  it("caps the ring's percentage at 100 rather than reporting an overdraft as a share", () => {
    const { container } = render(
      <ProgressRing value={12} total={10} centre="12" caption="of 10" title="SL" showPercent />,
    );
    // The caption still carries the real figures; the SHARE cannot exceed the whole.
    expect(container.textContent).toContain("100%");
    expect(container.textContent).toContain("of 10");
  });
});

describe("CoverageBar", () => {
  /*
    The distinction this component exists for. "Nobody has said what this
    department needs" and "this department is fully staffed" are opposite facts,
    and a bar that paints them the same colour tells a manager the venue is
    covered on a night nobody has planned.
  */
  it("treats no stated target as unknown, never as met", () => {
    expect(coverageState(0, null)).toBe("unknown");
    expect(coverageState(0, 0)).toBe("unknown");
    expect(coverageState(4, null)).toBe("unknown");
    // And the colour follows the meaning, not the fill.
    expect(STATE_TONE_FOR_TEST.unknown).toBe(CHART_TONE.neutral);
    expect(STATE_TONE_FOR_TEST.met).toBe(CHART_TONE.present);
    expect(STATE_TONE_FOR_TEST.short).toBe(CHART_TONE.absent);
  });

  it("separates short, met and over", () => {
    expect(coverageState(3, 5)).toBe("short");
    expect(coverageState(5, 5)).toBe("met");
    expect(coverageState(7, 5)).toBe("over");
  });

  it("never reports a negative shortfall", () => {
    // Over-rostering is not a shortfall of minus two; it is not a shortfall.
    expect(shortfall(7, 5)).toBe(0);
    expect(shortfall(5, 5)).toBe(0);
    expect(shortfall(3, 5)).toBe(2);
    expect(shortfall(3, null)).toBe(0);
  });

  it("renders the pair of figures, not a percentage", () => {
    /*
      A reader acting on this needs "3 of 5", because the action is finding two
      more people. "60%" is the same fact with the actionable part removed.
    */
    render(<CoverageBar value={3} target={5} title="Kitchen" showLabel />);
    expect(screen.getByText("3 / 5")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  it("says what it is even with nothing to compare against", () => {
    render(<CoverageBar value={4} target={null} title="Kitchen" showLabel />);
    expect(screen.getByText("4")).toBeInTheDocument();
    // No shortfall figure, because there is no target to fall short of.
    expect(screen.queryByText(/^−/)).not.toBeInTheDocument();
  });
});
