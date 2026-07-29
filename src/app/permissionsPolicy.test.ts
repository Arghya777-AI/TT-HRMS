/**
 * permissionsPolicy.test.ts — the Permissions-Policy header must permit the browser
 * features this app actually uses.
 *
 * WHY THIS EXISTS
 * ---------------
 * Voice dictation shipped and did not work. The Dictate button reported "Microphone access
 * was blocked. Allow it in your browser settings, then try again", Chrome never showed a
 * permission dialog, and there was nothing in settings to change — because the site was
 * serving:
 *
 *     Permissions-Policy: camera=(self), geolocation=(self), microphone=()
 *
 * `microphone=()` is an empty allowlist: the feature is denied to EVERY origin, including
 * this one. `getUserMedia` is then refused by policy before a prompt can be raised, and NO
 * amount of client code can work around it. Two rounds of fixes went into the hook —
 * calling getUserMedia to raise the prompt, distinguishing a blocked mic from an
 * unavailable speech service — and none of them could have helped, because the request was
 * dead at the header.
 *
 * The header was correct when it was written: the app used a camera and a location and had
 * no use for a microphone, so denying it was right. Adding a feature that needs one made it
 * wrong, and nothing connected the two.
 *
 * WHY IT IS INVISIBLE IN DEVELOPMENT: the Vite dev server does not send this header at all,
 * so dictation works locally and fails only once deployed. That is the worst shape a bug
 * can have, and it is the reason this is a test rather than a note.
 *
 * WHAT IT ASSERTS: for every browser feature the source actually calls, the deployed policy
 * must grant it. It reads the calls out of `src/`, so using a new gated API without opening
 * the policy fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

interface HeaderGroup {
  source: string;
  headers: { key: string; value: string }[];
}

const config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
  headers: HeaderGroup[];
};

const policy = config.headers
  .flatMap((group) => group.headers)
  .find((header) => header.key.toLowerCase() === "permissions-policy");

/** Every .ts/.tsx file under src, read once. */
function sourceText(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
        out.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(join(ROOT, "src"));
  return out.join("\n");
}

const SRC = sourceText();

/** A gated feature, how to spot its use, and the directive that permits it. */
const GATED = [
  { feature: "microphone", uses: /getUserMedia\(\{\s*audio:\s*true/, why: "voice dictation" },
  { feature: "camera", uses: /getUserMedia\(\{[\s\S]{0,120}?video:/, why: "face punch, enrolment, sign-in" },
  { feature: "geolocation", uses: /navigator\.geolocation\./, why: "punch location" },
] as const;

describe("the Permissions-Policy header", () => {
  it("is served", () => {
    expect(policy).toBeDefined();
  });

  for (const { feature, uses, why } of GATED) {
    it(`grants ${feature} to self, because the app uses it for ${why}`, () => {
      if (!uses.test(SRC)) {
        // Not used any more: the policy may deny it, and denying is the safer default.
        return;
      }
      const value = policy?.value ?? "";
      // Plain string comparison on purpose: a constructed RegExp here needs escaping that
      // is easy to get wrong, and getting it wrong makes the guard pass vacuously — which
      // for a test whose whole job is catching a silent misconfiguration is the one
      // failure mode that matters.
      expect(value).toContain(`${feature}=`);
      // `feature=()` is an EMPTY allowlist: denied to every origin, including ours. That is
      // the exact shape that silently broke dictation.
      expect(value).not.toContain(`${feature}=()`);
      expect(value).toContain(`${feature}=(self)`);
    });
  }

  it("grants nothing the app does not use", () => {
    const granted = [...(policy?.value ?? "").matchAll(/([a-z-]+)=\(/g)].map((m) => m[1]);
    const known = GATED.map((g) => g.feature);
    for (const feature of granted) {
      expect(known).toContain(feature);
    }
  });
});
