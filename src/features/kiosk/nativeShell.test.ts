/**
 * nativeShell.test.ts — the iOS shell and the web app have to agree, and Xcode cannot tell us.
 *
 * Nothing in `npm run build` or `tsc` looks at `ios/`, and nothing in Xcode looks at this
 * repo's TypeScript. Three facts have to hold across that gap, and each one fails in a way
 * that produces no error message at all:
 *
 *   1. THE BUNDLE IDENTIFIER. `public/app/manifest.plist` tells iOS what it is installing.
 *      If it disagrees with the built app, the install fails on the device saying only
 *      "Unable to Install" — no log, no reason, nothing on the Mac.
 *   2. THE BRIDGE VERSION. The shell announces a version and `nativeBridge.ts` refuses one
 *      below its minimum. Ship a shell older than the page expects and the page decides there
 *      is no shell, tries `getUserMedia`, and finds nothing — on iOS 12 that is a dead camera
 *      with the app looking otherwise healthy.
 *   3. THE DEPLOYMENT TARGET. 12.0 is the entire reason `ios/` exists. Raised to 13, the
 *      project still builds, still runs on every device anyone testing it is likely to hold,
 *      and cannot be installed on the one iPad it was written for.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** Pull a <string> out of a plist by its <key>. Enough for these flat files. */
function plistString(xml: string, key: string): string | null {
  const match = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
  ).exec(xml);
  return match === null ? null : match[1]!;
}

const iosPresent = existsSync(join(ROOT, "ios", "TTGate", "Info.plist"));

describe.skipIf(!iosPresent)("the iOS shell agrees with the web app", () => {
  const appPlist = read("ios", "TTGate", "Info.plist");
  const manifest = read("public", "app", "manifest.plist");
  const controller = read("ios", "TTGate", "GateViewController.swift");
  const bridge = read("src", "features", "kiosk", "lib", "nativeBridge.ts");
  const project = read("ios", "project.yml");

  it("installs the bundle identifier it actually builds", () => {
    const declared = plistString(manifest, "bundle-identifier");
    expect(declared).not.toBeNull();
    // The app's own Info.plist uses $(PRODUCT_BUNDLE_IDENTIFIER), so the literal lives in
    // project.yml — which is what Xcode reads.
    expect(project).toContain(`PRODUCT_BUNDLE_IDENTIFIER: ${declared!}`);
  });

  it("targets iOS 12.0, which is the only reason the shell exists", () => {
    expect(project).toMatch(/iOS:\s*"12\.0"/);
  });

  it("announces a bridge version the page will accept", () => {
    const shell = /bridgeVersion\s*=\s*(\d+)/.exec(controller);
    const minimum = /MIN_SHELL_VERSION\s*=\s*(\d+)/.exec(bridge);
    expect(shell).not.toBeNull();
    expect(minimum).not.toBeNull();
    expect(Number(shell![1])).toBeGreaterThanOrEqual(Number(minimum![1]));
  });

  it("speaks exactly the operations the page sends", () => {
    // A message the shell does not handle is silently dropped by WKWebView: the page waits
    // out its timeout and reports no frame, which reads as a camera fault.
    for (const op of ["startCamera", "stopCamera", "grabFrame", "cameraPermission"]) {
      expect(bridge, `page sends ${op}`).toContain(`op: "${op}"`);
      expect(controller, `shell handles ${op}`).toContain(`case "${op}"`);
    }
  });

  it("calls back into the globals the page installs", () => {
    expect(controller).toContain("window.__ttGateFrame");
    expect(controller).toContain("window.__ttGateControl");
    expect(bridge).toContain("__ttGateFrame");
    expect(bridge).toContain("__ttGateControl");
  });

  it("declares the camera usage string iOS requires to launch", () => {
    // Touching the camera without this makes iOS terminate the app on first use.
    expect(plistString(appPlist, "NSCameraUsageDescription")).toBeTruthy();
  });

  it("never reads UIKit off the main thread in the capture path", () => {
    // `grabFrame` runs on a background queue so the JPEG encode does not stutter the
    // preview. Reading UIApplication there is undefined behaviour.
    const camera = read("ios", "TTGate", "CameraController.swift")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(camera).not.toContain("UIApplication.shared");
  });
});

describe("the install page is reachable and correctly served", () => {
  const vercel = JSON.parse(read("vercel.json")) as {
    rewrites: { source: string; destination: string }[];
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };

  it("serves /app ahead of the SPA catch-all", () => {
    const sources = vercel.rewrites.map((r) => r.source);
    expect(sources.indexOf("/app")).toBeGreaterThanOrEqual(0);
    expect(sources.indexOf("/app")).toBeLessThan(sources.indexOf("/(.*)"));
  });

  it("sends the manifest as XML, which iOS will not install without", () => {
    const entry = vercel.headers.find((h) => h.source === "/app/manifest.plist");
    expect(entry).toBeDefined();
    const type = entry?.headers.find((h) => h.key === "Content-Type")?.value ?? "";
    expect(type).toContain("xml");
  });

  it("points the manifest at an .ipa on the same HTTPS origin", () => {
    const manifest = read("public", "app", "manifest.plist");
    const url = /<string>(https:\/\/[^<]*\.ipa)<\/string>/.exec(manifest);
    expect(url, "manifest must name an https .ipa").not.toBeNull();
    // Plain HTTP is refused by iOS outright, and a cross-origin host would also need its own
    // valid certificate — same-origin on Vercel is the only configuration that is already true.
    expect(url![1]).toContain("tt-hrms.vercel.app");
  });
});
