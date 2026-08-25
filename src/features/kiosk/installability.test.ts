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

  it("installs as its own app, not as the HR one", () => {
    /*
      Chrome keys installability on the manifest `id`. Sharing one would make the gate and the
      HR product the same installed app — and a wall-mounted terminal that opened somebody's
      payslips is the exact outcome the two-entry build exists to prevent.
    */
    const hr = JSON.parse(read("public", "manifest.webmanifest")) as {
      id: string;
      scope: string;
      name: string;
    };
    expect(manifest.id).not.toBe(hr.id);
    expect(manifest.scope).not.toBe(hr.scope);
    expect(manifest.name).not.toBe(hr.name);
    // The HR scope must not sit inside the gate's, or one worker could claim both apps.
    expect(hr.scope.startsWith(manifest.scope)).toBe(false);
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
