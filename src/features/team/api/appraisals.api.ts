/**
 * appraisals.api.ts — the review, and the evidence that sits beside it.
 *
 * /team/performance said for the life of the product that no appraisal cycle,
 * rating, goal or 1:1 note existed anywhere in the database, and showed the
 * attendance record instead — "evidence you can take into a review rather than a
 * number nothing stands behind". Migration 043900 built the review. The evidence
 * stays exactly where it was.
 *
 * ── NOTHING HERE JOINS ATTENDANCE TO A RATING ───────────────────────────────
 *
 * Deliberately, and it is the whole reason the tables were designed the way they
 * were. Punctuality is measured per person per day and would populate a score
 * with no effort at all; it would also say that a cook who is late twice a month
 * and holds the pass together on a Saturday is worse than one who is punctual and
 * slow. The two things are shown side by side on the screen and are never
 * multiplied together.
 *
 * ── NO AVERAGE IS COMPUTED ──────────────────────────────────────────────────
 *
 * `overall_rating` is what the reviewer typed. This module does not derive it
 * from the competency lines, and neither does the database — see the migration
 * header for why 3.25 is a worse answer than a sentence.
 */
import { z } from "zod";
import { nowInstantIso } from "@/lib/datetime";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  isNotNull,
  rpcAudited,
  selectMany,
  updateRow,
} from "@/shared/api/query";

export const APPRAISAL_CYCLES_TABLE = "appraisal_cycles";
export const APPRAISALS_TABLE = "appraisals";
export const APPRAISAL_RATINGS_TABLE = "appraisal_ratings";
export const APPRAISAL_PROGRESS_VIEW = "v_appraisal_cycle_progress";
export const SHARE_APPRAISAL_FN = "share_appraisal";

/** `ck_appr__status`, restated. */
export const appraisalStatusValues = [
  "not_started",
  "self_submitted",
  "manager_submitted",
  "shared",
  "acknowledged",
] as const;
export type AppraisalStatus = (typeof appraisalStatusValues)[number];

/** `ck_appr__overall` and `ck_aprate__*` — one to five, and nothing between. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_VALUES = [1, 2, 3, 4, 5] as const;

/** `ck_appr__manager_words` — a verdict needs words, and this is how many. */
export const MANAGER_COMMENT_MIN_LENGTH = 20;

export const appraisalCycleSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  period_from: dbDate,
  period_to: dbDate,
  self_due_on: dbDateNullable,
  manager_due_on: dbDateNullable,
  status: z.string(),
});
export type AppraisalCycle = z.infer<typeof appraisalCycleSchema>;

export const appraisalSchema = z.object({
  id: dbUuid,
  cycle_id: dbUuid,
  employee_id: dbUuid,
  reviewer_id: dbUuidNullable,
  status: z.string(),
  self_comment: z.string().nullable(),
  self_submitted_at: dbTimestampNullable,
  manager_comment: z.string().nullable(),
  overall_rating: dbIntNullable,
  manager_submitted_at: dbTimestampNullable,
  shared_at: dbTimestampNullable,
  employee_ack_at: dbTimestampNullable,
  employee_ack_note: z.string().nullable(),
  created_at: dbTimestamp,
});
export type Appraisal = z.infer<typeof appraisalSchema>;

export const appraisalRatingSchema = z.object({
  id: dbUuid,
  appraisal_id: dbUuid,
  competency_id: dbUuidNullable,
  label: z.string(),
  sort_order: dbInt,
  self_rating: dbIntNullable,
  manager_rating: dbIntNullable,
  manager_note: z.string().nullable(),
});
export type AppraisalRating = z.infer<typeof appraisalRatingSchema>;

const APPRAISAL_COLUMNS =
  "id, cycle_id, employee_id, reviewer_id, status, self_comment, self_submitted_at, " +
  "manager_comment, overall_rating, manager_submitted_at, shared_at, employee_ack_at, " +
  "employee_ack_note, created_at";

/** Cycles somebody may act in. Drafts are admin-only and RLS enforces that. */
export function fetchAppraisalCycles(signal?: AbortSignal): Promise<AppraisalCycle[]> {
  return selectMany(APPRAISAL_CYCLES_TABLE, appraisalCycleSchema, {
    filters: [inList("status", ["open", "closed"])],
    order: [{ column: "period_to", ascending: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The appraisals a caller may see in one cycle.
 *
 * No scope filter here: `appr__manager_all`, `appr__admin_all` and
 * `appr__self_select` already decide it, and a second predicate in the browser
 * would be a second, drifting definition of who reviews whom.
 */
export function fetchAppraisals(
  cycleId: string,
  signal?: AbortSignal,
): Promise<Appraisal[]> {
  return selectMany(APPRAISALS_TABLE, appraisalSchema, {
    columns: APPRAISAL_COLUMNS,
    filters: [eq("cycle_id", cycleId)],
    limit: 300,
    ...(signal ? { signal } : {}),
  });
}

/** My own appraisals — only ever the shared ones, by policy. */
export function fetchMyAppraisals(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Appraisal[]> {
  return selectMany(APPRAISALS_TABLE, appraisalSchema, {
    columns: APPRAISAL_COLUMNS,
    filters: [eq("employee_id", employeeId), isNotNull("shared_at")],
    order: [{ column: "created_at", ascending: false }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

export function fetchAppraisalRatings(
  appraisalId: string,
  signal?: AbortSignal,
): Promise<AppraisalRating[]> {
  return selectMany(APPRAISAL_RATINGS_TABLE, appraisalRatingSchema, {
    filters: [eq("appraisal_id", appraisalId)],
    order: [{ column: "sort_order", ascending: true }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

/** Save one competency line. Self and manager write different columns. */
export function saveRating(
  ratingId: string,
  patch: { self_rating?: number | null; manager_rating?: number | null; manager_note?: string | null },
  reason: string,
  signal?: AbortSignal,
): Promise<AppraisalRating> {
  return updateRow(APPRAISAL_RATINGS_TABLE, [eq("id", ratingId)], patch, appraisalRatingSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

export interface SubmitSelfInput {
  readonly appraisalId: string;
  readonly comment: string;
}

/**
 * Submit a self-assessment.
 *
 * `self_submitted_at` is stamped here rather than by a trigger because the
 * employee may save a draft comment first — the instant records the moment they
 * said "this is my answer", which is not the moment they last typed.
 */
export function submitSelfAssessment(
  input: SubmitSelfInput,
  reason: string,
  signal?: AbortSignal,
): Promise<Appraisal> {
  return updateRow(
    APPRAISALS_TABLE,
    [eq("id", input.appraisalId)],
    {
      self_comment: input.comment.trim() === "" ? null : input.comment.trim(),
      self_submitted_at: nowInstantIso(),
      status: "self_submitted",
    },
    appraisalSchema,
    { reason, columns: APPRAISAL_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

export interface SubmitReviewInput {
  readonly appraisalId: string;
  readonly comment: string;
  readonly overallRating: number;
}

/**
 * Submit the manager's review.
 *
 * The comment length is checked here AND by `ck_appr__manager_words`. The server
 * is what enforces it; this is so the refusal arrives in a sentence rather than
 * as a constraint name.
 */
export function submitManagerReview(
  input: SubmitReviewInput,
  reason: string,
  signal?: AbortSignal,
): Promise<Appraisal> {
  return updateRow(
    APPRAISALS_TABLE,
    [eq("id", input.appraisalId)],
    {
      manager_comment: input.comment.trim(),
      overall_rating: input.overallRating,
      manager_submitted_at: nowInstantIso(),
      status: "manager_submitted",
    },
    appraisalSchema,
    { reason, columns: APPRAISAL_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Show a completed review to the employee. Refuses an unfinished one. */
export async function shareAppraisal(
  appraisalId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<Appraisal> {
  const rows = await rpcAudited(
    SHARE_APPRAISAL_FN,
    { p_appraisal_id: appraisalId },
    appraisalSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
  const row = rows[0];
  if (row === undefined) throw new Error("The appraisal was not returned after sharing.");
  return row;
}

/** The employee's own acknowledgement that they have read it. */
export function acknowledgeAppraisal(
  appraisalId: string,
  note: string,
  reason: string,
  signal?: AbortSignal,
): Promise<Appraisal> {
  return updateRow(
    APPRAISALS_TABLE,
    [eq("id", appraisalId)],
    {
      employee_ack_at: nowInstantIso(),
      employee_ack_note: note.trim() === "" ? null : note.trim(),
      status: "acknowledged",
    },
    appraisalSchema,
    { reason, columns: APPRAISAL_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Is this review ready to be submitted? The same rule the server applies. */
export function reviewBlockers(comment: string, overall: number | null): string[] {
  const out: string[] = [];
  if (overall === null) out.push("overall");
  if (comment.trim().length < MANAGER_COMMENT_MIN_LENGTH) out.push("comment");
  return out;
}
