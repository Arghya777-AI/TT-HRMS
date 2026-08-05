/**
 * fabClearance.test.ts — the floating button must never sit on top of page content.
 *
 * WHAT WENT WRONG, SO THIS EXISTS
 *
 * The AI button is `position: fixed` at the bottom-right. `<main>` carried
 * `pb-20 md:pb-0` — zero bottom padding from the `md` breakpoint up — so on any desktop
 * a page's own content ran to the bottom edge UNDERNEATH it. On Add Employee that put
 * the form's Continue/Save button directly under the floating one, where it could not be
 * clicked.
 *
 * It was latent for as long as the button existed. Renaming it from "Ask TT" to "Regal
 * Lab AI Assistant" tripled its width and turned a near miss into a direct hit — which is
 * the giveaway that the layout was never actually safe, only lucky.
 *
 * WHY A TEST AND NOT JUST A FIX
 *
 * The fix is one padding class, and the next person to nudge the button's offset, make it
 * taller, or "clean up" an unused-looking `pb-40` has no way to know those numbers are
 * related. This test states the relationship: the reserved space must be at least the
 * button's own offset plus its height, per breakpoint. It reads the classes out of the
 * source, so it fails on the edit that breaks it rather than on a screenshot months later.
 *
 * It does NOT measure real layout — a jsdom test cannot. Actual occlusion was verified by
 * driving four pages in a browser and checking the button's box against every visible
 * control (317 of them, zero intersections).
 *
 * THEN THE iPHONE SAFE AREA JOINED THE ARITHMETIC
 *
 * Both figures are measured from the viewport's bottom edge, which on a notched phone is
 * BEHIND the home indicator. So both the button's offset and `<main>`'s padding now carry
 * `+ env(safe-area-inset-bottom)`, and this test checks the two halves separately:
 *
 *   · the constant parts still satisfy offset + height, as before; and
 *   · the padding's count of inset terms is at least the button's.
 *
 * The second half is the one worth stating. The inset cancels only while it appears on
 * both sides — drop it from `<main>` alone and the reservation silently shrinks by 34px on
 * exactly the devices that reported the original fault, while every desktop browser and
 * this test's first half stay perfectly green.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL = readFileSync(join(process.cwd(), "src/app/shell/AppShell.tsx"), "utf8");

/** A length in the source: its fixed part, and how many home-indicator insets it adds. */
interface Length {
  readonly px: number;
  readonly insets: number;
}

/**
 * Parse one Tailwind length: a spacing step (`24`), an arbitrary pixel value
 * (`[88px]`), or an arbitrary calc mixing both with the safe-area inset
 * (`[calc(5.5rem_+_env(safe-area-inset-bottom))]` — underscores are Tailwind's
 * escape for the spaces CSS requires around `+`).
 */
function parseLength(raw: string): Length {
  const arbitrary = /^\[(.+)\]$/.exec(raw)?.[1];
  // Tailwind's spacing scale is 0.25rem per step; 1rem = 16px.
  if (arbitrary === undefined) return { px: Number(raw) * 4, insets: 0 };
  const insets = (arbitrary.match(/env\(safe-area-inset-bottom\)/g) ?? []).length;
  const px = [...arbitrary.matchAll(/(\d*\.?\d+)(px|rem)/g)].reduce(
    (sum, match) => sum + Number(match[1]) * (match[2] === "rem" ? 16 : 1),
    0,
  );
  return { px, insets };
}

/**
 * The FAB's classes, isolated from the rest of the shell.
 *
 * By source range rather than by a `className="fixed…"` pattern: the classes moved into
 * a `cn()` of several strings when the safe-area offsets arrived, and a regex anchored to
 * one quoted run silently matched some other element's `h-14` instead — the failure mode
 * where a green test is reading the wrong thing entirely.
 */
function fabSource(): string {
  const start = SHELL.indexOf("AI FAB");
  expect(start, "could not find the AI FAB block in the shell").toBeGreaterThan(-1);
  const end = SHELL.indexOf("</Button>", start);
  expect(end, "could not find the end of the AI FAB block").toBeGreaterThan(start);
  return SHELL.slice(start, end);
}

/** The FAB's own geometry, read from its classes. */
function fabGeometry(): { height: Length; bottomMobile: Length; bottomDesktop: Length } {
  const fab = fabSource();
  const height = /\bh-(\d+)\b/.exec(fab)?.[1];
  // `["\s]` before `bottom-`: without it this also matches `md:bottom-`.
  const bottomMobile = /["\s]bottom-(\[[^\]]+\]|\d+)/.exec(fab)?.[1];
  const bottomDesktop = /\bmd:bottom-(\[[^\]]+\]|\d+)/.exec(fab)?.[1];
  expect(height, "could not read the FAB height class").toBeDefined();
  expect(bottomMobile, "could not read the FAB bottom offset").toBeDefined();
  expect(bottomDesktop, "could not read the FAB md:bottom offset").toBeDefined();
  return {
    height: parseLength(height ?? "0"),
    bottomMobile: parseLength(bottomMobile ?? "0"),
    bottomDesktop: parseLength(bottomDesktop ?? "0"),
  };
}

/** The space `<main>` reserves at the bottom, per breakpoint. */
function mainPadding(): { mobile: Length; desktop: Length } {
  const main = /<main className="([^"]+)"/.exec(SHELL)?.[1];
  expect(main, "could not find the <main> className").toBeDefined();
  const mobile = /(?:^|\s)pb-(\[[^\]]+\]|\d+)(?:\s|$)/.exec(main ?? "")?.[1];
  const desktop = /\bmd:pb-(\[[^\]]+\]|\d+)/.exec(main ?? "")?.[1];
  expect(mobile, "<main> has no base pb-* — content can slide under the FAB").toBeDefined();
  expect(desktop, "<main> has no md:pb-* — this is the exact bug that hid a Save button").toBeDefined();
  return { mobile: parseLength(mobile ?? "0"), desktop: parseLength(desktop ?? "0") };
}

describe("the floating AI button cannot cover page content", () => {
  it("reserves at least the button's offset + height on desktop", () => {
    const fab = fabGeometry();
    const pad = mainPadding();
    const needed = fab.bottomDesktop.px + fab.height.px;
    expect(
      pad.desktop.px,
      `<main> reserves ${pad.desktop.px}px at md+ but the FAB occupies the bottom ${needed}px ` +
        `(bottom ${fab.bottomDesktop.px}px + height ${fab.height.px}px). A page's last control ` +
        `will sit under it, exactly as the Add Employee Save button did.`,
    ).toBeGreaterThanOrEqual(needed);
  });

  it("reserves at least the button's offset + height on small screens", () => {
    /*
      The mobile offset is larger because the button clears the bottom tab bar, so the
      padding has to be larger again — the two numbers move together and this is the only
      place that says so.
    */
    const fab = fabGeometry();
    const pad = mainPadding();
    const needed = fab.bottomMobile.px + fab.height.px;
    expect(
      pad.mobile.px,
      `<main> reserves ${pad.mobile.px}px below md but the FAB occupies the bottom ${needed}px.`,
    ).toBeGreaterThanOrEqual(needed);
  });

  it("carries the home-indicator inset on both sides, at both breakpoints", () => {
    /*
      An iPad in standalone has a home bar too, so `md:` needs the inset every bit as much
      as the phone breakpoint does — which is why this checks both rather than assuming the
      desktop case is safe because a mouse pointer cannot be fooled.
    */
    const fab = fabGeometry();
    const pad = mainPadding();
    expect(
      pad.mobile.insets,
      "the FAB's offset grows with the home indicator but <main>'s padding does not, so the " +
        "reservation is short by that much on exactly the phones that reported the fault.",
    ).toBeGreaterThanOrEqual(fab.bottomMobile.insets);
    expect(
      pad.desktop.insets,
      "same mismatch at md+, where an iPad in standalone has a home indicator of its own.",
    ).toBeGreaterThanOrEqual(fab.bottomDesktop.insets);
  });

  it("still renders the button as fixed — the premise of the whole check", () => {
    // If it ever stops being fixed it flows with content and needs no reservation; this
    // test would then be asserting padding for no reason, so it should be revisited.
    expect(fabSource()).toMatch(/\bfixed\b/);
  });
});
