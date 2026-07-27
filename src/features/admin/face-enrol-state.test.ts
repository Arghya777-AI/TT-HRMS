/**
 * The two enrolment-console rules that encode schema facts rather than taste.
 * Both have a wrong answer that looks plausible on screen: five copies of one
 * capture, or "consent missing" for somebody the coverage view simply cannot see.
 */
import { describe, expect, it } from "vitest";
import {
  enrolmentState,
  representativeSets,
  type EnrolmentStateInput,
  type TemplateSetLike,
} from "./face-enrol-state";

/** One `secure.face_templates` row as the list op reports it. */
function row(
  version: number,
  opts: { active?: boolean; representative?: boolean; tag?: string } = {},
): TemplateSetLike & { tag: string } {
  return {
    version,
    isActive: opts.active ?? false,
    isRepresentative: opts.representative ?? false,
    tag: opts.tag ?? `v${version}`,
  };
}

describe("representativeSets", () => {
  it("collapses one capture's five sample rows to a single version", () => {
    const set = [
      row(2, { tag: "s0" }),
      row(2, { tag: "s1" }),
      row(2, { representative: true, tag: "medoid" }),
      row(2, { tag: "s3" }),
      row(2, { tag: "s4" }),
    ];
    const sets = representativeSets(set);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.tag).toBe("medoid");
  });

  it("keeps the nominated row even when a sibling is somehow active", () => {
    const sets = representativeSets([
      row(1, { active: true, tag: "sibling" }),
      row(1, { representative: true, tag: "medoid" }),
    ]);
    expect(sets[0]?.tag).toBe("medoid");
  });

  it("falls back to the active row when nothing is nominated", () => {
    const sets = representativeSets([
      row(1, { tag: "s0" }),
      row(1, { active: true, tag: "live" }),
    ]);
    expect(sets[0]?.tag).toBe("live");
  });

  it("returns one row per version, newest first", () => {
    const sets = representativeSets([
      row(1, { representative: true, tag: "v1" }),
      row(1, { tag: "v1-sibling" }),
      row(3, { representative: true, active: true, tag: "v3" }),
      row(2, { representative: true, tag: "v2" }),
    ]);
    expect(sets.map((s) => s.tag)).toEqual(["v3", "v2", "v1"]);
  });

  it("is empty for no templates, not undefined", () => {
    expect(representativeSets([])).toEqual([]);
  });
});

describe("enrolmentState", () => {
  const base: EnrolmentStateInput = {
    excludedFromAttendance: false,
    consent: "granted",
    hasSubmission: false,
    faceEnrolledAt: null,
  };

  it("reports an excluded employee before anything else", () => {
    expect(
      enrolmentState({
        ...base,
        excludedFromAttendance: true,
        consent: "none",
        faceEnrolledAt: "2026-07-01T04:30:00Z",
      }),
    ).toBe("excluded");
  });

  it("puts a withdrawal above an existing enrolment — it is the signal that matters", () => {
    expect(
      enrolmentState({ ...base, consent: "withdrawn", faceEnrolledAt: "2026-07-01T04:30:00Z" }),
    ).toBe("consent_withdrawn");
  });

  it("reports a waiting capture before an older enrolment", () => {
    expect(
      enrolmentState({ ...base, hasSubmission: true, faceEnrolledAt: "2026-01-01T04:30:00Z" }),
    ).toBe("awaiting_approval");
  });

  it("reports enrolled from the employee record alone", () => {
    expect(enrolmentState({ ...base, faceEnrolledAt: "2026-07-01T04:30:00Z" })).toBe("enrolled");
  });

  it("reports a KNOWN missing consent", () => {
    expect(enrolmentState({ ...base, consent: "none" })).toBe("no_consent");
  });

  it("never reports an UNKNOWN consent as a missing one", () => {
    expect(enrolmentState({ ...base, consent: "unknown" })).toBe("not_enrolled");
  });
});
