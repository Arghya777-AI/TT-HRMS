/**
 * stamp-sw.mjs — give the gate's service worker a version that changes when the gate does.
 *
 * ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
 * A browser installs a new service worker only when the SCRIPT BYTES DIFFER. The gate's worker
 * carried a hand-edited `const VERSION = "v3"`, and three deploys went out without anybody
 * touching it — the dwell rule, the offline face bundle, the Android install fix. Every
 * installed terminal therefore kept the worker it already had, never ran `install` or
 * `activate`, and never learned that anything had changed. Reported from the field as the PWA
 * simply not updating, and it was not: it had no reason to.
 *
 * A constant somebody has to remember to increment is a constant that will be forgotten, and
 * this one fails silently — the build passes, the deploy succeeds, and only the devices are
 * wrong. So it is derived instead.
 *
 * ── WHAT IT DERIVES IT FROM ──────────────────────────────────────────────────
 * A hash of the built gate ENTRY plus the shell HTML. Those change if and only if the gate's
 * code changes, which is exactly when a terminal needs to pick something up. It is not a
 * timestamp: a timestamp would change on every rebuild and force every device to re-download
 * a bundle that was byte-identical, on a venue's wifi, for nothing.
 *
 * Runs against `dist/`, never against `public/`, so the source keeps its placeholder and the
 * repo has nothing generated in it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const SW = join(DIST, "kiosk", "kiosk-sw.js");
const SHELL = join(DIST, "kiosk", "index.html");
const PLACEHOLDER = "__TT_BUILD__";

function fail(message) {
  console.error(`✗ stamp-sw: ${message}`);
  process.exit(1);
}

if (!existsSync(SW)) fail(`no built worker at ${SW} — run vite build first`);
if (!existsSync(SHELL)) fail(`no built shell at ${SHELL}`);

const worker = readFileSync(SW, "utf8");
if (!worker.includes(PLACEHOLDER)) {
  /*
    A hard failure, not a warning. If the placeholder is gone the worker is shipping with a
    literal `__TT_BUILD__` or with a stale hand-written version — and that is the exact
    condition this script was written to eliminate. A silent skip would restore the bug while
    looking like it had been fixed.
  */
  fail(
    `the built worker has no ${PLACEHOLDER} to replace. ` +
      "Restore it in public/kiosk/kiosk-sw.js — a worker whose bytes never change is a gate " +
      "that never updates.",
  );
}

/*
  The chunks the SHELL ITSELF references, read out of the built HTML.

  Not a glob over `dist/assets`: `kiosk-*.js` also matches `kiosk-display-*`, a chunk belonging
  to an admin screen the gate never loads. Including it would change this worker whenever that
  page changed, and every installed terminal would re-download and reload for nothing — on a
  venue's wifi. The shell names exactly what the gate boots, which is exactly what a terminal
  needs to notice.
*/
const shell = readFileSync(SHELL, "utf8");
const assets = join(DIST, "assets");
const referenced = [...new Set([...shell.matchAll(/\/assets\/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]))]
  .filter((f) => existsSync(join(assets, f)))
  .sort();
if (referenced.length === 0) fail("the built shell references no /assets/*.js — nothing to hash");

const material = [
  shell,
  ...referenced.map((f) => readFileSync(join(assets, f), "utf8")),
].join("\n");

const build = createHash("sha256").update(material).digest("hex").slice(0, 12);

writeFileSync(SW, worker.replaceAll(PLACEHOLDER, build), "utf8");
console.log(`✓ stamp-sw: kiosk worker version ${build} (from ${referenced.length} shell chunks)`);
