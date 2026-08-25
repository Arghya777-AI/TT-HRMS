/**
 * pwaUpdate.test.ts — an installed gate must be able to pick up a deploy.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * It could not. Reported from the field as the PWA simply not updating, and it was not one bug
 * but two, each of which alone was enough:
 *
 *   1. THE WORKER'S BYTES NEVER CHANGED. `VERSION` was a hand-edited `"v3"`, and a browser
 *      installs a new service worker only when the SCRIPT BYTES DIFFER. Three deploys went out
 *      — the dwell rule, the offline face bundle, the Android install fix — and none touched
 *      that file, so every installed terminal kept the worker it already had and never ran
 *      `install` or `activate`.
 *
 *   2. THE PAGE WAS NEVER TOLD. `clients.claim()` puts a new worker in charge, but the page is
 *      still RUNNING the bundle it booted with, and an installed PWA never navigates again — it
 *      is opened once and resumed from a frozen state for weeks. In a tab the next navigation
 *      fixes it. On a wall there is no next navigation.
 *
 * Neither is visible anywhere: the build passes, the deploy succeeds, the server serves the new
 * code, and only the devices are wrong. So both halves are asserted here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const source = read("public", "kiosk", "kiosk-sw.js");
const registration = read("src", "kiosk", "registerKioskServiceWorker.ts");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("the worker changes when the gate does", () => {
  it("carries a placeholder in source, never a hand-written version", () => {
    /*
      The exact bug. A constant somebody has to remember to increment is a constant that will be
      forgotten, and this one fails silently on the devices only.
    */
    expect(source).toContain('const VERSION = "__TT_BUILD__";');
    expect(source).not.toMatch(/const VERSION = "v\d+";/);
  });

  it("is stamped by the build, not by a person", () => {
    expect(pkg.scripts["build"]).toContain("scripts/stamp-sw.mjs");
  });

  it("derives the stamp from the gate's own code, not from a clock", () => {
    const stamper = read("scripts", "stamp-sw.mjs");
    // A timestamp would change on every rebuild and make every terminal re-download and reload
    // a byte-identical bundle over a venue's wifi.
    expect(stamper).toContain("createHash");
    expect(stamper).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    // And it must fail loudly rather than skip: a silent skip restores the bug while looking
    // like the fix is in place.
    expect(stamper).toContain("process.exit(1)");
  });
});

describe("the page finds out", () => {
  it("is told by the worker on activate", () => {
    expect(source).toContain("clients.matchAll");
    expect(source).toContain('type: "tt-gate-updated"');
  });

  it("takes over the open page rather than waiting for it to close", () => {
    // A gate has no unsaved state, and waiting for every client to close means waiting forever
    // on a terminal nobody ever closes.
    expect(source).toContain("skipWaiting");
    expect(source).toContain("clients.claim");
  });

  it("reloads on the message, and on controllerchange as a backstop", () => {
    expect(registration).toContain('data.type === "tt-gate-updated"');
    expect(registration).toContain("controllerchange");
    // Only once a controller already exists: on a first install the controller arrives for the
    // first time and reloading then is a pointless bounce.
    expect(registration).toContain("navigator.serviceWorker.controller !== null");
  });

  it("checks for a new worker on a timer, not only on visibilitychange", () => {
    /*
      `visibilitychange` covers a tablet somebody picks up. The gate this product is for is
      mounted, never touched and never backgrounded, so nothing there ever triggers a check.
    */
    expect(registration).toContain("registration.update()");
    expect(registration).toMatch(/setInterval\(\(\) => void registration\.update\(\)/);
  });

  it("never reloads between a face and its record", () => {
    // A reload mid-punch costs a re-scan. Small, and avoidable.
    expect(registration).toContain("ttGateBusy");
    const screen = read("src", "features", "kiosk", "screens", "GateScanScreen.tsx");
    expect(screen).toContain('document.body.dataset["ttGateBusy"]');
  });
});

describe("the built worker", () => {
  const built = join(ROOT, "dist", "kiosk", "kiosk-sw.js");

  it.skipIf(!existsSync(built))("has a real version, not the placeholder", () => {
    const code = readFileSync(built, "utf8");
    // Shipping the literal placeholder would be a worker whose bytes never change again.
    expect(code).not.toContain("__TT_BUILD__");
    expect(code).toMatch(/const VERSION = "[0-9a-f]{12}";/);
  });
});
