/**
 * The enrolment roster's arithmetic, which is the whole point of the module: an
 * administrator reads these numbers and chases people based on them.
 *
 * The cases that matter are the ones that were wrong before it existed — an enrolled
 * employee having no row at all, "not enrolled" not saying which of three things is
 * missing, and a withdrawn consent being counted as a shortfall so coverage could
 * never reach 100%.
 */
import { describe, expect, it } from "vitest";
import {
  buildEnrolmentStatusRows,
  matchesEnrolmentFilter,
  tallyEnrolment,
} from "./enrolmentStatus";
import type { EnrolmentRosterRow } from "./api/face-enrolment.api";
import type { EnrolmentGap } from "./api/system.api";

function person(id: string, code: string): EnrolmentRosterRow {
  return {
    id,
    employee_code: code,
    display_name: `Person ${code}`,
    employment_status: "active",
    department_name: "Front Office",
    designation_name: "Associate",
    date_of_join: "2026-01-05",
    work_email: `${code}@tamarindtree.co`,
    face_enrolled_at: null,
    exclude_from_attendance: false,
  } as EnrolmentRosterRow;
}

function gap(employeeId: string, kind: string): EnrolmentGap {
  return {
    employee_id: employeeId,
    employee_code: "X",
    display_name: "X",
    department_id: null,
    department_name: null,
    date_of_join: null,
    has_active_consent: kind !== "no_consent",
    consent_granted_at: kind === "no_consent" ? null : "2026-07-01T04:00:00Z",
    consent_withdrawn: kind === "consent_withdrawn",
    has_active_template: false,
    face_enrolled_at: null,
    gap_kind: kind,
  } as EnrolmentGap;
}

describe("buildEnrolmentStatusRows", () => {
  it("counts a roster row with no coverage row as enrolled", () => {
    const rows = buildEnrolmentStatusRows([person("a", "TT0001")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("enrolled");
    expect(rows[0]?.has_active_template).toBe(true);
  });

  it("keeps every enrollable employee, enrolled or not — the gap view alone loses the enrolled", () => {
    const rows = buildEnrolmentStatusRows(
      [person("a", "TT0001"), person("b", "TT0002"), person("c", "TT0003")],
      [gap("b", "no_consent")],
    );
    expect(rows.map((r) => r.employee_code)).toEqual(["TT0001", "TT0002", "TT0003"]);
    expect(rows.map((r) => r.state)).toEqual(["enrolled", "no_consent", "enrolled"]);
  });

  it("carries each gap kind through as its own state, not one flat 'no'", () => {
    const rows = buildEnrolmentStatusRows(
      [person("a", "1"), person("b", "2"), person("c", "3")],
      [gap("a", "no_consent"), gap("b", "consented_not_enrolled"), gap("c", "consent_withdrawn")],
    );
    expect(rows.map((r) => r.state)).toEqual([
      "no_consent",
      "consented_not_enrolled",
      "consent_withdrawn",
    ]);
  });

  it("treats an unrecognised gap_kind as not-enrolled rather than as a green tick", () => {
    const rows = buildEnrolmentStatusRows([person("a", "1")], [gap("a", "some_future_kind")]);
    expect(rows[0]?.state).toBe("consented_not_enrolled");
    expect(rows[0]?.gap_kind).toBe("some_future_kind");
  });

  it("does not let a stale face_enrolled_at stamp override the gap view's verdict", () => {
    const stamped = { ...person("a", "1"), face_enrolled_at: "2026-07-01T04:00:00Z" };
    const rows = buildEnrolmentStatusRows([stamped], [gap("a", "consent_withdrawn")]);
    expect(rows[0]?.state).toBe("consent_withdrawn");
    // Still shown as a date, because it is true that a template once existed.
    expect(rows[0]?.face_enrolled_at).toBe("2026-07-01T04:00:00Z");
  });
});

describe("attendance exclusion — the state that made two screens disagree", () => {
  /**
   * The live case: TT0017 is excluded from attendance AND carries a
   * `face_enrolled_at` stamp. `v_enrolment_coverage` only covers non-excluded
   * employees, so he is absent from it — and reading that absence as enrolment made
   * this module say 60 enrolled while the console's own state machine said 59.
   */
  const excluded = { ...person("v", "TT0017"), exclude_from_attendance: true };

  it("classifies an excluded employee as excluded, not enrolled, even when stamped", () => {
    const stamped = { ...excluded, face_enrolled_at: "2026-07-31T05:00:00Z" };
    const rows = buildEnrolmentStatusRows([stamped], []);
    expect(rows[0]?.state).toBe("excluded");
  });

  it("outranks every gap kind, matching enrolmentState()'s own order", () => {
    const rows = buildEnrolmentStatusRows([excluded], [gap("v", "no_consent")]);
    expect(rows[0]?.state).toBe("excluded");
  });

  it("is counted in neither enrolled nor notEnrolled, and the three still sum to total", () => {
    const rows = buildEnrolmentStatusRows(
      [person("a", "1"), person("b", "2"), excluded],
      [gap("b", "no_consent")],
    );
    const tally = tallyEnrolment(rows);
    expect(tally.total).toBe(3);
    expect(tally.enrolled).toBe(1);
    expect(tally.notEnrolled).toBe(1);
    expect(tally.excluded).toBe(1);
    expect(tally.enrolled + tally.notEnrolled + tally.excluded).toBe(tally.total);
  });

  it("stays out of the coverage denominator, like a withdrawn consent", () => {
    const rows = buildEnrolmentStatusRows([person("a", "1"), excluded], []);
    // 1 enrolled ÷ 1 eligible, not ÷ 2.
    expect(tallyEnrolment(rows).coveragePct).toBe(100);
  });

  it("is not swept into the 'not enrolled' filter", () => {
    const rows = buildEnrolmentStatusRows([excluded], []);
    expect(matchesEnrolmentFilter(rows[0]!, "not_enrolled")).toBe(false);
    expect(matchesEnrolmentFilter(rows[0]!, "excluded")).toBe(true);
    expect(matchesEnrolmentFilter(rows[0]!, "all")).toBe(true);
  });
});

describe("matchesEnrolmentFilter", () => {
  const rows = buildEnrolmentStatusRows(
    [person("a", "1"), person("b", "2"), person("c", "3"), person("d", "4")],
    [gap("b", "no_consent"), gap("c", "consented_not_enrolled"), gap("d", "consent_withdrawn")],
  );

  it("'all' keeps everyone", () => {
    expect(rows.filter((r) => matchesEnrolmentFilter(r, "all"))).toHaveLength(4);
  });

  it("'not_enrolled' is the union of all three gap kinds", () => {
    const out = rows.filter((r) => matchesEnrolmentFilter(r, "not_enrolled"));
    expect(out.map((r) => r.employee_code)).toEqual(["2", "3", "4"]);
  });

  it("'enrolled' and 'not_enrolled' partition the roster with no overlap", () => {
    const yes = rows.filter((r) => matchesEnrolmentFilter(r, "enrolled")).length;
    const no = rows.filter((r) => matchesEnrolmentFilter(r, "not_enrolled")).length;
    expect(yes + no).toBe(rows.length);
  });

  it("a specific gap kind selects only that kind", () => {
    const out = rows.filter((r) => matchesEnrolmentFilter(r, "no_consent"));
    expect(out.map((r) => r.employee_code)).toEqual(["2"]);
  });
});

describe("tallyEnrolment", () => {
  it("excludes withdrawn consents from coverage, so full coverage is reachable", () => {
    const rows = buildEnrolmentStatusRows(
      [person("a", "1"), person("b", "2")],
      [gap("b", "consent_withdrawn")],
    );
    const tally = tallyEnrolment(rows);
    expect(tally.total).toBe(2);
    expect(tally.enrolled).toBe(1);
    expect(tally.withdrawn).toBe(1);
    // 1 enrolled ÷ 1 eligible — not 50%.
    expect(tally.coveragePct).toBe(100);
  });

  it("counts each gap kind separately and notEnrolled as their sum", () => {
    const rows = buildEnrolmentStatusRows(
      [person("a", "1"), person("b", "2"), person("c", "3"), person("d", "4")],
      [gap("b", "no_consent"), gap("c", "consented_not_enrolled"), gap("d", "consent_withdrawn")],
    );
    const tally = tallyEnrolment(rows);
    expect(tally.noConsent).toBe(1);
    expect(tally.consentedNotEnrolled).toBe(1);
    expect(tally.withdrawn).toBe(1);
    expect(tally.notEnrolled).toBe(3);
    expect(tally.enrolled + tally.notEnrolled).toBe(tally.total);
  });

  it("reports no percentage rather than a fabricated one when there is nobody to count", () => {
    expect(tallyEnrolment([]).coveragePct).toBeNull();
  });

  it("gives 0% when everyone eligible is unenrolled", () => {
    const rows = buildEnrolmentStatusRows([person("a", "1")], [gap("a", "no_consent")]);
    expect(tallyEnrolment(rows).coveragePct).toBe(0);
  });
});
