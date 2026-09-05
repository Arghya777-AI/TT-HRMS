/**
 * The punch button is the first thing you can act on, on both layouts.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * Home opened with THREE stacked full-width blocks before anything actionable: a PageHeader
 * carrying the greeting and the date, a separate band carrying the shift and the weekly off,
 * and a four-line paragraph about face enrolment. On a laptop the punch button sat below the
 * fold; on a phone it was most of a screen down.
 *
 * The one thing an employee opens this page to do was the one thing they had to scroll for,
 * and the notice that pushed it down was not even actionable — "see HR or the security desk"
 * is not something anybody can do from a dashboard at 8am.
 *
 * ── WHAT HOLDS NOW ───────────────────────────────────────────────────────────
 *   · One band, not two: the greeting and the shift share a row, the shift living in the
 *     space the greeting was wasting on the right.
 *   · The punch card is the next thing after it, and it is FIRST in source order, so it is
 *     also the first card on a phone and the first thing a screen reader reaches.
 *   · The enrolment notice moved BELOW that row, became one line, and — on a draft — the whole
 *     row is a link to somewhere the employee can actually act.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const home = strip(read("src", "features", "home", "pages", "Home.page.tsx"));
const header = strip(read("src", "features", "home", "components", "HomeHeader.tsx"));
const bar = strip(read("src", "features", "home", "components", "AttentionBar.tsx"));
const punch = strip(read("src", "features", "attendance", "components", "SelfPunchCard.tsx"));
const today = strip(read("src", "features", "home", "components", "TodayCard.tsx"));

describe("nothing stands between the header and the punch card", () => {
  it("puts the punch card immediately after the header and the bar", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. Only the one-line attention bar may sit between them —
      the enrolment paragraph that used to is now an item INSIDE that bar, so it costs no
      height of its own.
    */
    const headerAt = home.indexOf("<HomeHeader");
    const barAt = home.indexOf("<AttentionBar");
    const punchAt = home.indexOf("<SelfPunchCard");
    expect(headerAt).toBeGreaterThan(-1);
    expect(barAt).toBeGreaterThan(headerAt);
    expect(punchAt).toBeGreaterThan(barAt);
    // The standalone full-width block is gone entirely.
    expect(home).not.toContain("<FaceEnrolmentAskCard");
  });

  it("keeps the punch card first in its row, so it is first on a phone", () => {
    const row = home.slice(home.indexOf("sm:grid-cols-2"), home.indexOf("<MyMonthCalendar"));
    expect(row.indexOf("<SelfPunchCard")).toBeLessThan(row.indexOf("<TodayCard"));
  });

  it("lets each card be its own height, so neither scrolls", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. The row capped every card to the shortest and scrolled
      the overflow inside — which put a scrollbar in the Attendance card, the one thing on
      this page nobody should have to scroll. That capping existed for the notification list,
      which is a bar now.
    */
    expect(home).not.toContain("<EqualHeightRow");
    expect(home).toContain("items-start");
  });

  it("is a TWO-card row now, not three", () => {
    /*
      A notification list is not a thing you do here. As a card it took a third of the first
      screen and, having no natural end, padded the other two to its own height.
    */
    expect(home).toContain('<div className="grid items-start gap-4 sm:grid-cols-2">');
    expect(home).not.toContain("<AttentionCard");
  });

  it("no longer renders a second full-width band above it", () => {
    /*
      The old greeting PageHeader + GreetingBand pair is what cost the fold. The one remaining
      PageHeader is the no-employee empty state — a different render path entirely, which
      never reaches the punch card — so this checks the GREETING is gone rather than banning
      the component.
    */
    expect(home).not.toContain("<GreetingBand");
    expect(home).not.toContain("greetingLine(");
    const main = home.slice(home.indexOf("<HomeHeader"));
    expect(main).not.toContain("<PageHeader");
  });
});

describe("two layouts, not one row bent", () => {
  it("arranges wide and narrow separately", () => {
    /*
      A wrapped single row put the shift under the avatar at an awkward indent and left the
      right half empty anyway. These are two arrangements of the same facts.
    */
    expect(header).toContain('className="hidden items-center gap-6 sm:flex"');
    expect(header).toContain('className="sm:hidden"');
  });

  it("uses the empty right-hand space for the shift on a wide screen", () => {
    const wide = header.slice(header.indexOf("sm:flex"), header.indexOf("sm:hidden"));
    expect(wide).toContain("{facts}");
    expect(wide).toContain("border-l pl-6");
  });

  it("puts the two facts side by side on a phone rather than stacking them", () => {
    // Stacking is two more rows between the greeting and the button.
    expect(header).toContain('className="mt-3 grid grid-cols-2 gap-3 border-t pt-3"');
  });

  it("builds the facts once and renders them in both", () => {
    // Two copies is how the phone and the laptop end up disagreeing about the shift.
    expect(header).toContain("const facts = (");
    expect(header.match(/\{facts\}/g) ?? []).toHaveLength(2);
  });
});

describe("the enrolment ask lives in the bar now", () => {
  it("is merged in rather than given a full-width block of its own", () => {
    /*
      On a phone that block was a whole card of vertical space for one sentence. It IS a
      notification — "HR has asked you to do something" — so it belongs in the list.
    */
    expect(bar).toContain("useMyFaceEnrolmentAsk");
    expect(bar).toContain("items.unshift(row);");
  });

  it("puts an actionable ask FIRST and a waiting one with the rest", () => {
    // A `pending` capture is already with an administrator; nothing is owed by the employee.
    expect(bar).toContain("if (awaiting) items.push(row);");
  });

  it("links an actionable ask somewhere it can be acted on", () => {
    // Not a capture screen: registration is admin-supervised, with the employee present.
    expect(bar).toContain('href: awaiting ? null : "/me/helpdesk"');
  });

  it("says nothing at all when there is nothing to say", () => {
    // A bar that renders on every visit to report calm trains people to stop reading it.
    expect(bar).toContain("if (query.isPending || ask.isPending) return null;");
  });

  it("shows the most urgent title on the collapsed line", () => {
    // "3 things need you" with no clue which makes everybody open it to find out.
    expect(bar).toContain("{first.title}");
  });
});

describe("the attendance card says less", () => {
  it("drops the lead sentence that repeated its own heading", () => {
    expect(punch).not.toContain('t("me.punch.lead")');
  });

  it("keeps the location reason BEFORE the browser prompt, but as one line", () => {
    /*
      The property that mattered was order, not length: somebody who has read why is far
      likelier to grant it. The paragraph is behind a disclosure now.
    */
    expect(punch).toContain('t("me.punch.location.short")');
    expect(punch).toContain("<details");
    expect(punch).toContain('t("me.punch.location.reason")');
  });
});

describe("a day that looks short says why", () => {
  it("warns when the scans read as closed but the shift has not ended", () => {
    /*
      Punch from home at 08:30, scan in at the gate at 12:40: the arrival CLOSES the morning
      session, so the day reads 08:30-12:40 and the figure looks like lost hours.
    */
    expect(today).toContain("const looksClosedMidShift =");
    expect(today).toContain("day.punch_count % 2 === 0 && checkedOut && shiftNotEnded");
  });

  it("does NOT hang it on shiftRunning, which is the opposite condition", () => {
    /*
      THE BUG THIS EXISTS FOR. A first draft used `shiftRunning`, which requires that nobody
      has scanned out — mutually exclusive with `checkedOut`. The notice could never have
      appeared, and it would have shipped as dead code that read correctly.
    */
    expect(today).toContain("const shiftNotEnded =");
    expect(today).not.toContain("=== 0 && shiftRunning &&");
  });

  it("tells the employee the figure completes itself", () => {
    expect(today).toContain('t("home.today.mayRecalc.title")');
    expect(today).toContain('t("home.today.mayRecalc.body")');
  });

  it("states the three rules that generate every question", () => {
    /*
      What the extra scans in the middle do, what arriving early does, and what coming back
      after the shift does. Each was only ever explained after somebody complained.
    */
    expect(today).toContain('t("home.today.rules.inside")');
    expect(today).toContain('t("home.today.rules.early")');
    expect(today).toContain('t("home.today.rules.late")');
  });

  it("actually RENDERS on that condition, not merely computes it", () => {
    /*
      Asserting the derivation and the copy is not enough: both survive a change that stops
      rendering the block, and the notice would silently never appear.
    */
    expect(today).toContain("{looksClosedMidShift ? (");
  });
});
