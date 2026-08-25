/**
 * The gate app is installable — asserted, because the failure mode is silent.
 *
 * The service worker was registered with scope `/kiosk/` while the gate is served at
 * `/kiosk`. A scope is a URL PREFIX, so `/kiosk/` does not contain `/kiosk`: registration
 * succeeded, threw nothing, logged nothing, and controlled nothing. The manifest, the icons
 * and the worker were all served correctly with the right MIME types, and the tablet still
 * offered no "Install app" — because Chrome only offers it when a worker controls the
 * manifest's `start_url`. Offline was dead for the same reason.
 *
 * Nothing about that is visible in a build, a typecheck or a screenshot, and a person
 * "tidying" a trailing slash would reintroduce it. Hence these assertions: the four places
 * that have to agree on one string, and the server header without which the shorter scope is
 * not even permitted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** The one address the gate lives at, and the string every layer must agree on. */
const GATE_PATH = "/kiosk";

const manifest = JSON.parse(read("public", "kiosk.webmanifest")) as {
  id: string;
  name: string;
  start_url: string;
  scope: string;
  display: string;
  display_override?: string[];
  icons: { src: string; sizes: string; purpose?: string }[];
};
const registration = read("src", "kiosk", "registerKioskServiceWorker.ts");
const worker = read("public", "kiosk", "kiosk-sw.js");
const vercel = JSON.parse(read("vercel.json")) as {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

describe("the gate app is installable", () => {
  it("registers the worker at the scope the gate is actually served at", () => {
    // The exact bug. `/kiosk/` here silently un-installs the app.
    expect(registration).toContain(`{ scope: "${GATE_PATH}" }`);
    expect(registration).not.toContain(`scope: "${GATE_PATH}/"`);
  });

  it("caches the shell under the URL that is navigated to", () => {
    expect(worker).toContain(`const SHELL_URL = "${GATE_PATH}";`);
  });

  it("names a start_url inside the worker's scope", () => {
    expect(manifest.scope).toBe(GATE_PATH);
    expect(manifest.start_url.startsWith(GATE_PATH)).toBe(true);
    // A start_url outside scope is the precise condition that suppresses the install
    // prompt, so assert containment rather than merely that both fields exist.
    expect(manifest.start_url.startsWith(`${GATE_PATH}/`)).toBe(false);
  });

  it("is served the header without which the shorter scope is rejected", () => {
    // A worker script at /kiosk/kiosk-sw.js may only claim /kiosk/ or deeper unless the
    // server widens it. Without this the registration above fails outright.
    const swHeaders = vercel.headers.find((h) => h.source === "/kiosk/kiosk-sw.js");
    expect(swHeaders).toBeDefined();
    expect(swHeaders?.headers).toEqual(
      expect.arrayContaining([{ key: "Service-Worker-Allowed", value: GATE_PATH }]),
    );
  });

  it("serves the gate entry ahead of the SPA catch-all", () => {
    // Order is meaningful in vercel.json: `/(.*)` → /index.html would otherwise hand the
    // HR app to anybody opening the gate.
    const sources = vercel.rewrites.map((r) => r.source);
    const gate = sources.indexOf(GATE_PATH);
    const catchAll = sources.indexOf("/(.*)");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(catchAll);
  });

  it("is a different app from the HR one", () => {
    const hr = JSON.parse(read("public", "manifest.webmanifest")) as {
      id: string;
      scope: string;
      name: string;
    };
    expect(manifest.id).not.toBe(hr.id);
    expect(manifest.scope).not.toBe(hr.scope);
    expect(manifest.name).not.toBe(hr.name);
  });

  it("has its own ORIGIN to install from, because scope nesting cannot be fixed", () => {
    /*
      THE ASSERTION THIS FILE GOT WRONG ONCE, AND WHY IT MATTERED.

      It used to check `hr.scope.startsWith(gate.scope)` — the harmless direction, which passes
      trivially because "/" does not start with "/kiosk". The direction that decides anything is
      the reverse: the GATE's scope sits INSIDE the HR app's `/`. An installed web app owns its
      scope, so on a device where TT HRMS is installed, Chrome sees an app whose scope already
      covers /kiosk and offers to OPEN it instead of installing — "you already have this app."
      Differing `id`, `name` and `scope` make no difference; containment is what is checked.

      Narrowing the HR scope is not available: its routes span /me, /admin, /apply and more, so
      "/" is the only prefix that covers them.

      Installed apps are keyed PER ORIGIN, so the fix is a second origin with no HR app on it.
      This asserts the nesting really is there — if it ever stops being, this test should be
      revisited rather than silently kept — and that the separate origin is written down where
      somebody installing the gate will actually read it.
    */
    const hr = JSON.parse(read("public", "manifest.webmanifest")) as { scope: string };
    expect(
      manifest.scope.startsWith(hr.scope),
      "the gate scope is no longer inside the HR scope — re-evaluate whether a separate origin is still needed",
    ).toBe(true);

    const GATE_ORIGIN = "tt-gate.vercel.app";
    expect(read("kiosk", "index.html")).toContain(GATE_ORIGIN);
    expect(read("vercel.json")).toContain(GATE_ORIGIN);
    // Typing the bare host must reach the gate, not the HR app.
    const vercelConfig = JSON.parse(read("vercel.json")) as {
      rewrites: { source: string; has?: { type: string; value: string }[]; destination: string }[];
    };
    const hostRule = vercelConfig.rewrites.find((r) =>
      r.has?.some((h) => h.type === "host" && h.value === GATE_ORIGIN),
    );
    expect(hostRule?.destination).toBe("/kiosk/index.html");
  });

  it("gives the gate its own reload, because an installed app has none", () => {
    /*
      `display: fullscreen` is the point of installing this — and it means there is no address
      bar and no reload button. A terminal that wedged, or that got slow after a failed scan, had
      no way back short of somebody force-quitting the app. That is the one recovery a person at
      the door can perform without knowing anything, so it has to be ON the screen.

      Asserted in both places: the scan screen, where it is large and replaces the camera
      chooser, and the shared frame, which covers the screens reached before scanning.
    */
    expect(manifest.display).toBe("fullscreen");
    const scan = read("src", "features", "kiosk", "screens", "GateScanScreen.tsx");
    const frame = read("src", "features", "kiosk", "components", "GateChrome.tsx");
    expect(scan).toContain("window.location.reload()");
    expect(frame).toContain("window.location.reload()");
    // A document reload, not a React remount: remounting leaves the camera track, the face
    // engine and the scan loop exactly as wedged as they were.
    expect(scan).not.toMatch(/setKey\(|remount/);
  });

  it("offers no camera choice, because the rear one faces the wall", () => {
    const scan = read("src", "features", "kiosk", "screens", "GateScanScreen.tsx");
    // Front, always. A public screen with a control that breaks it will eventually be pressed.
    expect(scan).toContain('useCamera(videoRef, { initial: "user", remember: false })');
    expect(scan).not.toContain("<CameraChoice");
    // And the native shell must agree, or the app and the browser would frame the same face
    // differently and produce different descriptors from it.
    const native = read("src", "features", "kiosk", "hooks", "useNativeCamera.ts");
    expect(native).toContain('const DEFAULT_FACING: CameraFacing = "front";');
  });

  it("declares the icons and display mode an install needs", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    // Android requires a maskable icon or it draws a white box behind the artwork.
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    // iPadOS ignores `fullscreen` and needs `standalone` reachable through the override
    // list, or it opens the "app" in a Safari tab with an address bar.
    expect(manifest.display_override ?? []).toContain("standalone");
  });
});
