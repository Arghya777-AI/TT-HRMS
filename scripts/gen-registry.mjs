#!/usr/bin/env node
/**
 * gen-registry.mjs — regenerates src/features/registry.ts from the page files.
 *
 * WHY THIS EXISTS
 * ---------------
 * registry.ts used to be hand-appended: every feature agent added its own line
 * to one shared file. Concurrent agents each rewrote it whole, so the last
 * writer won and silently DELETED the other 30 registrations — 43 page files
 * existed on disk while only 11 routes rendered anything. Routes that worked
 * yesterday regressed to <PageStub> with no error anywhere.
 *
 * The fix is to remove the shared file from the write path entirely. Each page
 * now declares its own route in its own header:
 *
 *     @route /admin/org/departments
 *
 * and this script derives the registry from those declarations. Two agents can
 * never conflict, because each one only ever writes its own file.
 *
 * Every declared route must exist in src/app/route-manifest.ts, and no two
 * pages may claim the same route — both are hard errors, because either one
 * means a screen the user can reach by URL renders the wrong thing (or nothing).
 *
 * Usage:  node scripts/gen-registry.mjs [--check]
 *   --check  verify registry.ts is up to date without writing (for CI/gates).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: a URL keeps spaces percent-encoded, so a repo
// checked out under a directory like "Tamarind Tree" would look for "…%20Tree".
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FEATURES = join(ROOT, "src/features");
const MANIFEST = join(ROOT, "src/app/route-manifest.ts");
const REGISTRY = join(ROOT, "src/features/registry.ts");
const CHECK = process.argv.includes("--check");

/* ── 1. The set of legal routes, from the manifest ───────────────────────── */
function manifestPaths() {
  const src = readFileSync(MANIFEST, "utf8");
  // Redirect pairs are legal URLs but are not screens — never registrable.
  const redirectBlock = /const REDIRECTS[\s\S]*?\n\];/.exec(src)?.[0] ?? "";
  const body = src.replace(redirectBlock, "");
  const paths = new Set();
  // Object form:  { path: "/me/leave", title: ... }
  for (const m of body.matchAll(/\bpath:\s*"([^"]+)"/g)) paths.add(m[1]);
  // Admin tuple form:  ["/admin/org/grades", "Grades", "A", ...]
  for (const m of body.matchAll(/^\s*\[\s*"(\/[^"]+)"\s*,/gm)) paths.add(m[1]);
  if (paths.size < 100) {
    throw new Error(
      `route-manifest.ts yielded only ${paths.size} paths — the extraction is ` +
        `out of step with the manifest's shape. Refusing to generate a registry ` +
        `that would drop routes.`,
    );
  }
  return paths;
}

/* ── 2. Every page file and the route it claims ──────────────────────────── */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".page.tsx")) out.push(p);
  }
  return out;
}

/**
 * Prefer an explicit `@route` tag. Fall back to the longest route-shaped string
 * in the file header, which is how the first generation of pages documented
 * themselves — longest wins because a detail page's header usually also
 * mentions the list page it is reached from.
 */
function claimedRoute(file) {
  const src = readFileSync(file, "utf8");

  // Pages the router mounts itself (the kiosk gate, the auth screens) live
  // outside the capability-gated tree and must NOT be in PAGE_REGISTRY.
  const standalone = /@route-standalone\s+(\/\S+)/.exec(src);
  if (standalone) return { standalone: standalone[1] };

  const tag = /@route\s+(\/\S+)/.exec(src);
  if (tag) return { route: tag[1], explicit: true };

  const header = src.slice(0, src.indexOf("*/") + 2 || 1200);
  const candidates = [...header.matchAll(/(\/(?:me|team|admin|kiosk)(?:\/[A-Za-z0-9:_-]+)*)/g)]
    .map((m) => m[1])
    .filter((p, i, a) => a.indexOf(p) === i)
    .sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? { route: candidates[0], explicit: false } : null;
}

function hasDefaultExport(file) {
  return /export\s+default\s/.test(readFileSync(file, "utf8"));
}

/* ── 3. Build, validate, emit ───────────────────────────────────────────── */
const legal = manifestPaths();
const files = walk(FEATURES).sort();

const byRoute = new Map();
const problems = [];
const inferred = [];
const standalone = [];
/*
  Everything that can MOUNT a standalone page, not just the router.

  This used to read `src/app/routes.tsx` alone, which was correct while the product was
  one app. The gate terminal is now a second Vite entry (`kiosk/index.html` →
  `src/kiosk/main.tsx`) that renders its page directly and deliberately has no router at
  all — so the check reported the kiosk screen as unreachable at the exact moment it
  became reachable, and failed the build.

  The guarantee is unchanged and still worth having: a page that opts out of the registry
  must be imported by something that actually mounts it. Only the list of things that
  count as a mount point has grown. Any future `src/<app>/main.tsx` is picked up without
  editing this script, which is the point of globbing rather than listing.
*/
const mountSources = [
  join(ROOT, "src/app/routes.tsx"),
  ...readdirSync(join(ROOT, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, "src", entry.name, "main.tsx"))
    .filter((candidate) => existsSync(candidate)),
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

for (const file of files) {
  const rel = relative(join(ROOT, "src/features"), file).replace(/\.tsx$/, "");
  const claim = claimedRoute(file);

  if (claim?.standalone) {
    // Assert the claim is true: a page that opts out of the registry but that
    // the router never imports is unreachable, which is the exact silent
    // failure this script exists to prevent.
    if (!mountSources.includes(rel.replace(/\\/g, "/"))) {
      problems.push(
        `${rel}: marked @route-standalone ${claim.standalone} but no mount point ` +
          `(src/app/routes.tsx or any src/*/main.tsx) imports it — the screen would be unreachable`,
      );
      continue;
    }
    standalone.push(`${rel} → ${claim.standalone}`);
    continue;
  }

  if (!claim) {
    problems.push(`${rel}: declares no route — add "@route /some/path" to its header`);
    continue;
  }
  if (!hasDefaultExport(file)) {
    problems.push(`${rel}: no default export, cannot be lazily routed`);
    continue;
  }
  if (!legal.has(claim.route)) {
    problems.push(`${rel}: claims ${claim.route}, which is not in route-manifest.ts`);
    continue;
  }
  const prior = byRoute.get(claim.route);
  if (prior) {
    problems.push(`${claim.route}: claimed by BOTH ${prior} and ${rel}`);
    continue;
  }
  byRoute.set(claim.route, rel);
  if (!claim.explicit) inferred.push(`${rel} → ${claim.route}`);
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} registry problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  process.exit(1);
}

// Deepest paths first is not required by the router (the manifest owns order),
// but a stable alphabetical sort keeps the generated diff readable.
const rows = [...byRoute.entries()].sort(([a], [b]) => a.localeCompare(b));

const out = `/**
 * registry.ts — GENERATED. Do not edit by hand.
 *
 * Run \`npm run gen:registry\` after adding a page. Each page declares its own
 * route with an \`@route\` tag in its header; this file is derived from those
 * declarations so that no two feature authors ever write the same file (an
 * earlier hand-maintained version lost 30+ registrations to concurrent edits).
 *
 * Anything absent here renders <PageStub> from the route manifest metadata, so
 * the route always exists, is deep-linkable, and never 404s mid-build.
 *
 * ${rows.length} of ${legal.size} routes are built.
 */
import type { ComponentType, LazyExoticComponent } from "react";

export type PageModule = { default: ComponentType };
export type PageLoader = () => Promise<PageModule>;

/** path → dynamic import of the page module. */
export const PAGE_REGISTRY: Readonly<Record<string, PageLoader>> = {
${rows.map(([route, mod]) => `  "${route}": () => import("./${mod}"),`).join("\n")}
};

/** Populated at runtime by the router; exported for tests. */
export type LazyPage = LazyExoticComponent<ComponentType>;
`;

const existing = (() => {
  try {
    return readFileSync(REGISTRY, "utf8");
  } catch {
    return "";
  }
})();

if (CHECK) {
  if (existing !== out) {
    console.error(
      "✗ registry.ts is stale — run `npm run gen:registry` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`✓ registry.ts up to date (${rows.length} routes built)`);
  process.exit(0);
}

writeFileSync(REGISTRY, out);
console.log(`✓ registry.ts: ${rows.length} routes built of ${legal.size} declared`);
if (inferred.length > 0) {
  console.log(
    `\n  ${inferred.length} route(s) inferred from prose rather than an @route tag:`,
  );
  for (const i of inferred) console.log(`    ${i}`);
}
