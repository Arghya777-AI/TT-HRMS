/**
 * The offline matcher, which is allowed to be uncertain and is never allowed to be wrong.
 *
 * An offline gate is where a wrong name does the most damage: nobody is watching, the person
 * walks off satisfied, and the mistake only surfaces when the queue drains and the server names
 * somebody else. So these tests are weighted towards refusal — the ambiguity rule, the
 * confidence floor and the expiry are each worth more than the happy path.
 *
 * They also pin the numbers against `kiosk-punch`. A matcher that used its own thresholds would
 * name people the server would refuse, which is the one outcome nobody could explain.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_MARGIN,
  confidenceFor,
  matchLocally,
} from "./localMatch";
import type { FaceBundle, BundlePerson } from "./faceBundle";

const DIM = 128;

/** A unit vector pointing mostly along one axis, so distances are easy to reason about. */
function vec(axis: number, tilt = 0): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = Math.cos(tilt);
  v[(axis + 1) % DIM] = Math.sin(tilt);
  return v;
}

function person(id: string, descriptors: number[][]): BundlePerson {
  return {
    employeeId: `emp-${id}`,
    employeeCode: id,
    displayName: `Person ${id}`,
    employmentStatus: "active",
    modelVersion: "v1",
    descriptors: descriptors.map((d) => new Float32Array(d)),
  };
}

function bundle(people: BundlePerson[], expiresInMs = 60_000): FaceBundle {
  return {
    version: "v-test",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    descriptorDim: DIM,
    people,
    fetchedAt: new Date().toISOString(),
  };
}

describe("thresholds agree with the server", () => {
  const punch = readFileSync(
    join(process.cwd(), "supabase/functions/kiosk-punch/index.ts"),
    "utf8",
  );

  it("uses kiosk-punch's confidence floor and margin", () => {
    expect(punch).toContain(`const DEFAULT_MIN_CONFIDENCE = ${DEFAULT_MIN_CONFIDENCE};`);
    expect(punch).toContain(`const DEFAULT_MIN_MARGIN = ${DEFAULT_MIN_MARGIN};`);
  });

  it("converts distance to confidence the same way", () => {
    // 1 - d/2. Two opposed unit vectors are 2 apart, which is confidence 0.
    expect(punch).toContain("return 1 - distance / MAX_UNIT_DISTANCE;");
    expect(punch).toContain("const MAX_UNIT_DISTANCE = 2;");
    expect(confidenceFor(0)).toBe(1);
    expect(confidenceFor(2)).toBe(0);
    expect(confidenceFor(0.5)).toBeCloseTo(0.75, 10);
  });
});

describe("matching", () => {
  it("names the closest person when they are clearly closest", () => {
    const b = bundle([person("A", [vec(0)]), person("B", [vec(40)])]);
    const result = matchLocally(b, vec(0));
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.employeeCode).toBe("A");
      expect(result.confidence).toBe(1);
    }
  });

  it("takes the best sample per PERSON, not per template", () => {
    /*
      The rule that keeps the margin meaningful. Ranking samples directly would fill the top
      places with one face, make the runner-up that same person again, and collapse the margin
      to nearly nothing — so every honest scan would be refused as ambiguous.
    */
    const many = person("A", [vec(0), vec(0, 0.02), vec(0, 0.04), vec(0, 0.06), vec(0, 0.08)]);
    const other = person("B", [vec(40)]);
    const result = matchLocally(bundle([many, other]), vec(0, 0.01));
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.employeeCode).toBe("A");
      // The runner-up is B, so the margin is large despite A having five near-identical samples.
      expect(result.margin).toBeGreaterThan(DEFAULT_MIN_MARGIN);
    }
  });

  it("refuses when two people are too close to separate", () => {
    // Both a hair from the probe: exactly the case where guessing is worse than declining.
    const b = bundle([person("A", [vec(0, 0.01)]), person("B", [vec(0, 0.02)])]);
    const result = matchLocally(b, vec(0));
    expect(result.kind).toBe("ambiguous");
  });

  it("refuses when nobody is close enough", () => {
    // Orthogonal vectors are sqrt(2) apart → confidence ≈ 0.293, well under the floor.
    const result = matchLocally(bundle([person("A", [vec(0)])]), vec(64));
    expect(result.kind).toBe("no_match");
    if (result.kind === "no_match") {
      expect(result.bestConfidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    }
  });

  it("refuses a single close candidate no more than it must", () => {
    // One person, no runner-up: the margin is infinite, so only confidence decides.
    const result = matchLocally(bundle([person("A", [vec(0)])]), vec(0));
    expect(result.kind).toBe("matched");
  });
});

describe("refusing to use data it cannot vouch for", () => {
  it("will not match on an expired bundle", () => {
    /*
      The expiry is the only lever that bounds how long a withdrawn consent or a revoked device
      keeps being honoured on hardware nobody can physically reach. A long outage must degrade
      to "cannot name people", not to naming them from stale templates.
    */
    const b = bundle([person("A", [vec(0)])], -1_000);
    expect(matchLocally(b, vec(0)).kind).toBe("unavailable");
  });

  it("will not match on an unparseable expiry", () => {
    const b = { ...bundle([person("A", [vec(0)])]), expiresAt: "whenever" };
    // Fails closed. An expiry nobody can read is not permission to proceed.
    expect(matchLocally(b, vec(0)).kind).toBe("unavailable");
  });

  it("will not match an empty or absent bundle", () => {
    expect(matchLocally(null, vec(0)).kind).toBe("unavailable");
    expect(matchLocally(bundle([]), vec(0)).kind).toBe("unavailable");
  });

  it("will not match a probe of the wrong width", () => {
    // A descriptor of another dimension is another model's output; comparing them is meaningless
    // rather than merely inaccurate.
    const result = matchLocally(bundle([person("A", [vec(0)])]), [0.1, 0.2, 0.3]);
    expect(result.kind).toBe("unavailable");
  });
});

describe("the early-exit optimisation does not change any answer", () => {
  it("agrees with a plain full-distance search over a crowded bundle", () => {
    /*
      `squaredDistance` abandons a candidate once it is already further than the best so far,
      which is what keeps 365 comparisons fast on an old iPad. An optimisation that changed a
      verdict would be a wrong name, so it is checked against the naive computation.
    */
    const people = Array.from({ length: 30 }, (_, i) =>
      person(`P${i}`, [vec(i * 4), vec(i * 4, 0.03)]),
    );
    const b = bundle(people);

    for (const axis of [0, 12, 28, 60, 100]) {
      const probe = vec(axis, 0.01);
      const result = matchLocally(b, probe);

      // Naive: full euclidean distance to every sample, best per person.
      let bestCode: string | null = null;
      let bestDist = Infinity;
      for (const p of people) {
        for (const d of p.descriptors) {
          let sum = 0;
          for (let i = 0; i < DIM; i += 1) sum += (d[i]! - probe[i]!) ** 2;
          const dist = Math.sqrt(sum);
          if (dist < bestDist) {
            bestDist = dist;
            bestCode = p.employeeCode;
          }
        }
      }

      if (result.kind === "matched") {
        expect(result.employeeCode, `axis ${axis}`).toBe(bestCode);
      } else {
        // Where it declines, the naive winner must have been below the bar too.
        expect(confidenceFor(bestDist)).toBeLessThan(DEFAULT_MIN_CONFIDENCE + DEFAULT_MIN_MARGIN);
      }
    }
  });
});
