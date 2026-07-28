/**
 * analyticsCapabilities.ts — metrics that are DECLARED but not yet collectable, and
 * the machinery that switches them on by themselves when the data arrives.
 *
 * THE ASK
 * -------
 *   "No recruitment, vacancy data, performance rating, or engagement service. At least
 *    put them as a placeholder, and make the system so that when the data comes in,
 *    we'll give it."
 *
 * Right instinct, with one trap worth naming. A placeholder that LOOKS like a working
 * tile — a card showing "—" or, worse, "0" — is not neutral. In a demo it reads as a
 * broken product, and months later somebody quotes the zero in a meeting. Analytics
 * earns its trust by being unambiguous about what it does and does not know.
 *
 * So a planned metric renders as an explicitly unavailable card that says WHICH source
 * it is waiting for and WHAT would switch it on. Nothing is fabricated, nothing is
 * zero, and the gap is legible rather than mysterious.
 *
 * HOW IT SWITCHES ITSELF ON
 * -------------------------
 * Each entry names the relation it needs. `probeMetricSource` asks PostgREST for one
 * row and reads three distinguishable outcomes:
 *
 *   PGRST205 (relation absent)  -> "planned"   — the table has not been built yet
 *   200 with zero rows          -> "awaiting"  — the table exists, nobody has filled it
 *   200 with rows               -> "live"      — render the real metric
 *
 * The middle state is the one that matters operationally: "we built the recruitment
 * module and nobody has entered a requisition" is a completely different conversation
 * from "we never built it", and a dashboard that cannot tell them apart sends somebody
 * to the wrong team.
 *
 * WHY A REGISTRY RATHER THAN A `TODO` IN EACH SCREEN
 * -------------------------------------------------
 * The list of what this product cannot yet answer is itself information an HR head
 * wants, and it belongs in one auditable place instead of scattered across a dozen
 * components. `docs/analytics-catalogue.md` carries the reasoning; this file is the
 * machine-readable half, and the two are meant to be read together.
 */

/** What the dashboard can currently do with a declared metric. */
export type MetricSourceState =
  /** The relation does not exist. Nobody has built this yet. */
  | "planned"
  /** The relation exists but holds no rows for the current filters. */
  | "awaiting"
  /** Real data. Render the metric. */
  | "live";

export type MetricCategory =
  | "recruitment"
  | "performance"
  | "engagement"
  | "compensation"
  | "learning";

export interface PlannedMetric {
  /** Stable key; used for query keys and for the registry test. */
  readonly key: string;
  readonly category: MetricCategory;
  /** What an HR head would call it. */
  readonly label: string;
  /** The question it answers, in one line, for the card's body. */
  readonly question: string;
  /**
   * The PostgREST relation that must exist and hold rows. `null` where the measure
   * needs more than one new relation — those say so rather than pretending a single
   * table would do it.
   */
  readonly relation: string | null;
  /** The columns the metric will read, so whoever builds the table knows the contract. */
  readonly expects: readonly string[];
  /** Plain sentence: what has to happen for this to light up. */
  readonly enabledBy: string;
}

/**
 * Everything the client asked for that the schema genuinely cannot answer today.
 *
 * Each entry is a CONTRACT, not a wish: `relation` and `expects` are what the analytics
 * layer will read the moment they exist, so the team building the recruitment module
 * has the shape it must produce rather than having to guess and be corrected later.
 */
export const PLANNED_METRICS: readonly PlannedMetric[] = [
  {
    key: "open_positions",
    category: "recruitment",
    label: "Open positions",
    question: "How many roles are we currently trying to fill, and where?",
    relation: "job_requisitions",
    expects: ["id", "department_id", "designation_id", "status", "opened_on", "closed_on", "headcount"],
    enabledBy:
      "A recruitment module writing one row per approved requisition. Until then headcount analytics show who IS here, never who is missing.",
  },
  {
    key: "time_to_hire",
    category: "recruitment",
    label: "Time to hire",
    question: "How long does a role stay open, from approval to joining?",
    relation: "job_requisitions",
    expects: ["opened_on", "closed_on", "filled_by_employee_id"],
    enabledBy:
      "The same requisition table, plus the join date already on employees. Computed as closed_on − opened_on; no new employee data is needed.",
  },
  {
    key: "offer_acceptance",
    category: "recruitment",
    label: "Offer acceptance rate",
    question: "What share of the offers we make are accepted?",
    relation: "job_offers",
    expects: ["requisition_id", "issued_on", "status", "decided_on"],
    enabledBy: "An offer table. Distinct from requisitions: one role can carry several offers.",
  },
  {
    key: "performance_rating",
    category: "performance",
    label: "Appraisal ratings",
    question: "How is each person rated, and how does that move over cycles?",
    relation: "performance_reviews",
    expects: ["employee_id", "cycle_id", "rating", "reviewer_id", "submitted_at"],
    enabledBy:
      "An appraisal cycle. IMPORTANT: what the dashboard shows today is ATTENDANCE performance — punctuality, hours, overtime, anomalies — and it is labelled as such. It must never be presented as a judgement of someone's work, because the system has not made one.",
  },
  {
    key: "goal_attainment",
    category: "performance",
    label: "Goal attainment",
    question: "What proportion of agreed objectives are being met?",
    relation: "performance_goals",
    expects: ["employee_id", "cycle_id", "weight", "target", "achieved"],
    enabledBy: "A goals table with a measurable target per goal, or the attainment is unauditable.",
  },
  {
    key: "engagement_score",
    category: "engagement",
    label: "Engagement score",
    question: "How do people feel about working here, and which teams are drifting?",
    relation: "survey_responses",
    expects: ["survey_id", "employee_id", "question_id", "score", "submitted_at"],
    enabledBy:
      "A survey tool writing responses. Report at team level only and suppress small groups — a department of three has no anonymity, and an engagement score nobody trusts is worse than none.",
  },
  {
    key: "enps",
    category: "engagement",
    label: "eNPS",
    question: "Would our people recommend working here?",
    relation: "survey_responses",
    expects: ["survey_id", "employee_id", "score"],
    enabledBy: "The same survey table, restricted to the recommendation question.",
  },
  {
    key: "pay_equity",
    category: "compensation",
    label: "Pay equity / compa-ratio",
    question: "Is anyone paid materially outside their band for the same work?",
    relation: null,
    expects: ["grade_id", "band_min_paise", "band_mid_paise", "band_max_paise"],
    enabledBy:
      "Salary BANDS per grade. Individual salaries and revision history already exist (v_employee_current_salary, v_salary_revisions) — the missing half is the midpoint to compare against, so compa-ratio cannot be computed from what we hold.",
  },
  {
    key: "training_completion",
    category: "learning",
    label: "Training completion",
    question: "Who has completed required training, and what is expiring?",
    relation: "training_records",
    expects: ["employee_id", "course_id", "completed_on", "expires_on"],
    enabledBy:
      "A training record per employee per course. The certification CLAIM flow exists, but a claim is a reimbursement request, not evidence of completion — reporting one as the other would overstate compliance.",
  },
] as const;

export function plannedMetricsFor(category: MetricCategory): readonly PlannedMetric[] {
  return PLANNED_METRICS.filter((m) => m.category === category);
}

export function plannedMetric(key: string): PlannedMetric | undefined {
  return PLANNED_METRICS.find((m) => m.key === key);
}

/** PostgREST's code for "no such table or view" — the signal that means "not built". */
export const RELATION_ABSENT_CODE = "PGRST205";

/**
 * Decide a metric's state from what a probe query returned.
 *
 * Pure, so the three-way decision is unit-testable without a network — the whole point
 * of the mechanism is the distinction between "never built" and "built but empty", and
 * that distinction is exactly the kind of thing that rots silently if untested.
 */
export function resolveMetricState(probe: {
  readonly relationExists: boolean;
  readonly rowCount: number;
}): MetricSourceState {
  if (!probe.relationExists) return "planned";
  return probe.rowCount > 0 ? "live" : "awaiting";
}

/**
 * A metric with no single relation (pay equity needs salary bands AND grades) can never
 * resolve itself by probing one name, so it stays "planned" until somebody wires it
 * deliberately. Saying that out loud beats a probe that silently always fails.
 */
export function isSelfResolving(metric: PlannedMetric): boolean {
  return metric.relation !== null;
}
