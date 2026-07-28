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
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL = readFileSync(join(process.cwd(), "src/app/shell/AppShell.tsx"), "utf8");

/** Tailwind's spacing scale is 0.25rem per step; 1rem = 16px. */
function stepToPx(step: string): number {
  const arbitrary = /^\[(\d+)px\]$/.exec(step);
  if (arbitrary?.[1] !== undefined) return Number(arbitrary[1]);
  return Number(step) * 4;
}

/** The FAB's own geometry, read from its classes. */
function fabGeometry(): { heightPx: number; bottomMobilePx: number; bottomDesktopPx: number } {
  const height = /className="fixed[^"]*\bh-(\d+)\b/.exec(SHELL)?.[1];
  const bottomMobile = /\bbottom-(\[\d+px\]|\d+)\b/.exec(SHELL)?.[1];
  const bottomDesktop = /\bmd:bottom-(\[\d+px\]|\d+)\b/.exec(SHELL)?.[1];
  expect(height, "could not read the FAB height class").toBeDefined();
  expect(bottomMobile, "could not read the FAB bottom offset").toBeDefined();
  expect(bottomDesktop, "could not read the FAB md:bottom offset").toBeDefined();
  return {
    heightPx: stepToPx(height ?? "0"),
    bottomMobilePx: stepToPx(bottomMobile ?? "0"),
    bottomDesktopPx: stepToPx(bottomDesktop ?? "0"),
  };
}

/** The space `<main>` reserves at the bottom, per breakpoint. */
function mainPadding(): { mobilePx: number; desktopPx: number } {
  const main = /<main className="([^"]+)"/.exec(SHELL)?.[1];
  expect(main, "could not find the <main> className").toBeDefined();
  const mobile = /(?:^|\s)pb-(\[\d+px\]|\d+)(?:\s|$)/.exec(main ?? "")?.[1];
  const desktop = /\bmd:pb-(\[\d+px\]|\d+)\b/.exec(main ?? "")?.[1];
  expect(mobile, "<main> has no base pb-* — content can slide under the FAB").toBeDefined();
  expect(desktop, "<main> has no md:pb-* — this is the exact bug that hid a Save button").toBeDefined();
  return { mobilePx: stepToPx(mobile ?? "0"), desktopPx: stepToPx(desktop ?? "0") };
}

describe("the floating AI button cannot cover page content", () => {
  it("reserves at least the button's offset + height on desktop", () => {
    const fab = fabGeometry();
    const pad = mainPadding();
    const needed = fab.bottomDesktopPx + fab.heightPx;
    expect(
      pad.desktopPx,
      `<main> reserves ${pad.desktopPx}px at md+ but the FAB occupies the bottom ${needed}px ` +
        `(bottom-${fab.bottomDesktopPx / 4} + h-${fab.heightPx / 4}). A page's last control ` +
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
    const needed = fab.bottomMobilePx + fab.heightPx;
    expect(
      pad.mobilePx,
      `<main> reserves ${pad.mobilePx}px below md but the FAB occupies the bottom ${needed}px.`,
    ).toBeGreaterThanOrEqual(needed);
  });

  it("still renders the button as fixed — the premise of the whole check", () => {
    // If it ever stops being fixed it flows with content and needs no reservation; this
    // test would then be asserting padding for no reason, so it should be revisited.
    expect(SHELL).toMatch(/className="fixed bottom-/);
  });
});
