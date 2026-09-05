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
const ask = strip(read("src", "features", "home", "components", "FaceEnrolmentAskCard.tsx"));

describe("nothing stands between the header and the punch card", () => {
  it("puts the punch card immediately after the header", () => {
    // THE REGRESSION THIS EXISTS FOR.
    const headerAt = home.indexOf("<HomeHeader");
    const punchAt = home.indexOf("<SelfPunchCard");
    const askAt = home.indexOf("<FaceEnrolmentAskCard");
    expect(headerAt).toBeGreaterThan(-1);
    expect(punchAt).toBeGreaterThan(headerAt);
    expect(askAt).toBeGreaterThan(punchAt);
  });

  it("keeps the punch card first in its row, so it is first on a phone", () => {
    const row = home.slice(home.indexOf("<EqualHeightRow"), home.indexOf("</EqualHeightRow>"));
    expect(row.indexOf("<SelfPunchCard")).toBeLessThan(row.indexOf("<TodayCard"));
    expect(row.indexOf("<TodayCard")).toBeLessThan(row.indexOf("<AttentionCard"));
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

describe("the enrolment notice can be acted on", () => {
  it("is a link when there is something to do", () => {
    expect(ask).toContain('<Link\n          to="/me/helpdesk"');
  });

  it("is NOT a link when the employee has nothing left to do", () => {
    /*
      A `pending` row means a capture is already with an administrator. A button that leads
      nowhere useful teaches people to stop pressing them.
    */
    expect(ask).toContain("{awaitingApproval ? (");
    expect(ask).toContain('<span className="flex items-start gap-2.5 px-3 py-2.5">{body}</span>');
  });

  it("shows one line, with the detail behind a disclosure", () => {
    expect(ask).toContain("me.faceAsk.draft.lead");
    expect(ask).toContain("<details");
    expect(ask).toContain("me.faceAsk.more");
  });

  it("still says when it was asked, and still says nothing when there is no ask", () => {
    expect(ask).toContain("me.faceAsk.asked");
    expect(ask).toContain("if (ask.data === undefined || ask.data === null) return null;");
  });
});
