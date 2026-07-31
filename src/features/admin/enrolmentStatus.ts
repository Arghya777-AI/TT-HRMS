/**
 * enrolmentStatus.ts — "is this person's face enrolled, and if not, what is missing".
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. `/admin/kiosk/enrolment` used to render
 * `v_enrolment_coverage` and nothing else. That view is a GAP list by construction —
 * its predicate is `(no active consent) OR (no active template)` — so the screen could
 * only ever answer "who is missing something". An administrator asking the ordinary
 * question, "who is enrolled and who is not", got a grid of people to chase and no
 * denominator, and an enrolled employee appeared nowhere at all. Reported as: the
 * page looks blank, and the only thing on it is a column of Enrol buttons.
 *
 * So the roster (`v_admin_employee`, every enrollable employee) is the spine, and the
 * coverage view is joined ONTO it. Absence from the coverage view is what "enrolled"
 * means — the same predicate the gate uses, not a second opinion assembled here. That
 * matters: `employees.face_enrolled_at` is a convenience stamp on the employee record
 * and can disagree with the secure schema (a template deactivated or purged, a consent
 * withdrawn, all of which leave the stamp behind). Deriving enrolment from the stamp
 * is how a screen starts telling somebody they are enrolled while the gate refuses
 * them, so the stamp is DISPLAYED as a date and never used as the verdict.
 *
 * ABSENCE FROM THE COVERAGE VIEW IS NOT ALWAYS ENROLMENT. The view's population is
 * non-excluded employees, so somebody with `exclude_from_attendance` is missing from it
 * for a reason that has nothing to do with their face — the gate will never look for
 * them. Reading that absence as enrolment is what made this module disagree with the
 * per-employee console: it counted Vinod Maurya (TT0017, excluded, and stamped
 * enrolled) as enrolled while the console called him excluded, so one screen said 60
 * enrolled and the other 59. `excluded` is therefore checked FIRST here, in the same
 * order as `enrolmentState()` in `face-enrol-state.ts`, and the two now agree by
 * construction rather than by coincidence.
 *
 * EXCLUDED AND WITHDRAWN ARE NOT SHORTFALLS. Neither counts toward `notEnrolled`, and
 * neither sits in the coverage denominator. An administrator chasing enrolment must
 * not be handed a to-do that can never be closed — one of these people has lawfully
 * declined biometrics and the other is not on the attendance system at all.
 *
 * NOT-ENROLLED IS NEVER JUST "NO". Each gap kind is a different action by a different
 * person: `no_consent` needs the consent ceremony first, `consented_not_enrolled`
 * needs a capture, and `consent_withdrawn` needs nothing at all — that employee has
 * declined biometrics, punches by another method and must never be chased. Collapsing
 * the three into one red word is what produced a to-do list with people on it who
 * should not be on any list.
 */
import type { EnrolmentGap } from "./api/system.api";
import type { EnrolmentRosterRow } from "./api/face-enrolment.api";

/**
 * Every gap kind `v_enrolment_coverage` can report, plus `enrolled` for the rows the
 * view (correctly) says nothing about.
 */
export const ENROLMENT_STATES = [
  "enrolled",
  "no_consent",
  "consented_not_enrolled",
  "consent_withdrawn",
  /** `employees.exclude_from_attendance` — the gate would never look for them. */
  "excluded",
] as const;

export type EnrolmentState = (typeof ENROLMENT_STATES)[number];

/**
 * What the filter row offers. `not_enrolled` is the union of the three gap kinds —
 * NOT of "everything that is not enrolled", because `excluded` is neither enrolled
 * nor a shortfall and belongs in neither column.
 */
export const ENROLMENT_FILTERS = [
  "all",
  "enrolled",
  "not_enrolled",
  "no_consent",
  "consented_not_enrolled",
  "consent_withdrawn",
  "excluded",
] as const;

export type EnrolmentFilter = (typeof ENROLMENT_FILTERS)[number];

/** One person, with the enrolment question answered. */
export interface EnrolmentStatusRow {
  readonly employee_id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly employment_status: string;
  readonly department_name: string | null;
  readonly designation_name: string | null;
  readonly date_of_join: string | null;
  readonly work_email: string | null;
  readonly state: EnrolmentState;
  /** The coverage view's own words, kept for the not-enrolled rows. */
  readonly gap_kind: string | null;
  readonly consent_granted_at: string | null;
  readonly has_active_template: boolean;
  /**
   * `employees.face_enrolled_at` — shown as "since when", never used to decide
   * `state`. See the header.
   */
  readonly face_enrolled_at: string | null;
}

/**
 * Join the roster to the coverage view.
 *
 * `excluded` is tested BEFORE anything else, exactly as `enrolmentState()` does, because
 * an excluded employee is absent from the coverage view no matter what their face
 * situation is — see the header. After that, a roster row with no coverage row is
 * enrolled: consent is on file AND a live template exists, which is the gate's own
 * precondition. An unrecognised `gap_kind` (a value added to the enum ahead of this
 * code) is treated as not-enrolled with the server's own string preserved, because the
 * safe direction to fail is "something is missing" rather than a green tick nobody
 * verified.
 */
export function buildEnrolmentStatusRows(
  roster: readonly EnrolmentRosterRow[],
  gaps: readonly EnrolmentGap[],
): EnrolmentStatusRow[] {
  const gapByEmployee = new Map<string, EnrolmentGap>();
  for (const gap of gaps) gapByEmployee.set(gap.employee_id, gap);

  return roster.map((person) => {
    const gap = gapByEmployee.get(person.id);
    const state: EnrolmentState = person.exclude_from_attendance
      ? "excluded"
      : gap === undefined
        ? "enrolled"
        : gap.gap_kind === "no_consent" ||
            gap.gap_kind === "consented_not_enrolled" ||
            gap.gap_kind === "consent_withdrawn"
          ? gap.gap_kind
          : "consented_not_enrolled";

    return {
      employee_id: person.id,
      employee_code: person.employee_code,
      display_name: person.display_name,
      employment_status: person.employment_status,
      department_name: person.department_name,
      designation_name: person.designation_name,
      date_of_join: person.date_of_join,
      work_email: person.work_email,
      state,
      gap_kind: gap?.gap_kind ?? null,
      consent_granted_at: gap?.consent_granted_at ?? null,
      has_active_template: gap === undefined ? true : gap.has_active_template,
      face_enrolled_at: person.face_enrolled_at,
    };
  });
}

/** Does this row belong under the chosen filter? */
export function matchesEnrolmentFilter(row: EnrolmentStatusRow, filter: EnrolmentFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "enrolled":
      return row.state === "enrolled";
    case "not_enrolled":
      // The three gap kinds, and deliberately NOT `excluded` — see ENROLMENT_FILTERS.
      return row.state !== "enrolled" && row.state !== "excluded";
    default:
      return row.state === filter;
  }
}

export interface EnrolmentTally {
  readonly total: number;
  readonly enrolled: number;
  /** The three gap kinds only. `enrolled + notEnrolled + excluded === total`. */
  readonly notEnrolled: number;
  readonly noConsent: number;
  readonly consentedNotEnrolled: number;
  readonly withdrawn: number;
  readonly excluded: number;
  /**
   * Enrolled ÷ (total − withdrawn − excluded), 0–100, rounded. Neither a withdrawn
   * consent nor an attendance exclusion is a shortfall — counting either would mean
   * coverage could never reach 100% at a venue where somebody has lawfully declined or
   * is not on the attendance system, and the number would be quietly wrong forever.
   * `null` when there is nobody to be a percentage of.
   */
  readonly coveragePct: number | null;
}

export function tallyEnrolment(rows: readonly EnrolmentStatusRow[]): EnrolmentTally {
  let enrolled = 0;
  let noConsent = 0;
  let consentedNotEnrolled = 0;
  let withdrawn = 0;
  let excluded = 0;

  for (const row of rows) {
    if (row.state === "enrolled") enrolled += 1;
    else if (row.state === "no_consent") noConsent += 1;
    else if (row.state === "consented_not_enrolled") consentedNotEnrolled += 1;
    else if (row.state === "consent_withdrawn") withdrawn += 1;
    else excluded += 1;
  }

  const eligible = rows.length - withdrawn - excluded;
  return {
    total: rows.length,
    enrolled,
    notEnrolled: noConsent + consentedNotEnrolled + withdrawn,
    noConsent,
    consentedNotEnrolled,
    withdrawn,
    excluded,
    coveragePct: eligible <= 0 ? null : Math.round((enrolled / eligible) * 100),
  };
}
