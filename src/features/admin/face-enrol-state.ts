/**
 * face-enrol-state.ts — the two derivations behind the per-employee enrolment
 * console that are easy to get wrong and worth a test.
 *
 * Both encode a fact about the DEPLOYED schema, not a UI preference, which is why
 * they live away from the component and are covered by `face-enrol-state.test.ts`:
 *
 *  1. `representativeSets` — `face-enrol` stores one `secure.face_templates` row
 *     PER ACCEPTED SAMPLE (five rows sharing one `version`, `sample_count` and
 *     `consent_id`) and nominates the medoid through
 *     `face_enrolment_requests.resulting_template_id`, surfaced by the list op as
 *     `isRepresentative`. A screen that does not collapse them shows one pending
 *     capture as five identical versions — and, worse, `face-template-admin
 *     approve` sets `is_active = (id = <the id you sent>)`, so handing it a
 *     SIBLING would make a non-medoid frame the matchable face.
 *
 *  2. `enrolmentState` — the order of the tests is the product rule. A WITHDRAWN
 *     consent outranks everything (spec-admin §5.10: those employees punch by the
 *     alternative method and are never chased), and an unknown consent must never
 *     be reported as a missing one, because `v_enrolment_coverage` simply cannot
 *     see a pre-joining or long-leave employee.
 */

/** What the console says about one employee, and the tone it says it in. */
export type EnrolmentConsoleState =
  | "enrolled"
  | "awaiting_approval"
  | "not_enrolled"
  | "no_consent"
  | "consent_withdrawn"
  | "excluded";

export type ConsentState = "granted" | "withdrawn" | "none" | "unknown";

/** The subset of a template row these rules need — structural, so tests stay small. */
export interface TemplateSetLike {
  readonly version: number;
  readonly isActive: boolean;
  readonly isRepresentative: boolean;
}

/**
 * One row per version: the nominated (medoid) row wins, then the active one, then
 * whichever arrived first. Newest version first.
 */
export function representativeSets<T extends TemplateSetLike>(templates: readonly T[]): T[] {
  const rank = (tpl: T): number => (tpl.isRepresentative ? 2 : 0) + (tpl.isActive ? 1 : 0);
  const byVersion = new Map<number, T>();
  for (const tpl of templates) {
    const held = byVersion.get(tpl.version);
    if (held === undefined || rank(tpl) > rank(held)) byVersion.set(tpl.version, tpl);
  }
  return [...byVersion.values()].sort((a, b) => b.version - a.version);
}

export interface EnrolmentStateInput {
  /** `employees.exclude_from_attendance` — the gate would never look for them. */
  readonly excludedFromAttendance: boolean;
  readonly consent: ConsentState;
  /** A `pending` `face_enrolment_requests` row, or a pending template set. */
  readonly hasSubmission: boolean;
  /** `employees.face_enrolled_at` — stamped on approval, cleared on revocation. */
  readonly faceEnrolledAt: string | null;
}

export function enrolmentState(input: EnrolmentStateInput): EnrolmentConsoleState {
  if (input.excludedFromAttendance) return "excluded";
  if (input.consent === "withdrawn") return "consent_withdrawn";
  if (input.hasSubmission) return "awaiting_approval";
  if (input.faceEnrolledAt !== null) return "enrolled";
  // 'unknown' is NOT 'none': absence from the coverage view is not evidence.
  if (input.consent === "none") return "no_consent";
  return "not_enrolled";
}
