/**
 * onboardingAdmin.api.ts — the HR side of first-login onboarding.
 *
 * `v_onboarding_queue` decides who is visible and whether the caller may act
 * (`can_manage` is true for a scoped admin only, never a manager), so this module reads and
 * writes and never judges. Both writes are definer functions that re-check authority.
 */
import { z } from "zod";
import { dbDateNullable, dbUuid, rpcOne, selectMany } from "@/shared/api/query";

export const ONBOARDING_QUEUE_VIEW = "v_onboarding_queue";

export const onboardingStates = ["not_started", "awaiting_review", "waived", "reviewed"] as const;
export type OnboardingState = (typeof onboardingStates)[number];

export const queueRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  date_of_join: dbDateNullable,
  department_name: z.string().nullable(),
  employment_type: z.string().nullable(),
  submitted_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  review_note: z.string().nullable(),
  waived_at: z.string().nullable(),
  waived_reason: z.string().nullable(),
  state: z.enum(onboardingStates),
  /** Required document types with nothing uploaded. */
  outstanding_documents: z.number(),
  can_manage: z.boolean(),
});

export type QueueRow = z.infer<typeof queueRowSchema>;

export async function fetchOnboardingQueue(signal?: AbortSignal): Promise<QueueRow[]> {
  return selectMany(ONBOARDING_QUEUE_VIEW, queueRowSchema, {
    // Not-started first: those are the people HR has to chase, and they sort before the
    // ones already dealt with.
    order: [
      { column: "state", ascending: true },
      { column: "employee_code", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

/** Record that HR checked a submitted onboarding. Grants nothing. */
export async function reviewOnboarding(employeeId: string, note?: string): Promise<string> {
  const at = await rpcOne(
    "review_onboarding",
    { p_employee_id: employeeId, p_note: note ?? null },
    z.string(),
  );
  if (at === null) throw new Error("The review could not be recorded.");
  return at;
}

/**
 * Waive the paperwork for a joiner who has none.
 *
 * The server still requires an Aadhaar or PAN on file and a reason of at least ten
 * characters; both refusals come back as plain sentences, so they are surfaced as-is rather
 * than re-worded here — the server's wording is the accurate one.
 */
export async function waiveOnboarding(employeeId: string, reason: string): Promise<string> {
  const at = await rpcOne(
    "waive_onboarding",
    { p_employee_id: employeeId, p_reason: reason },
    z.string(),
  );
  if (at === null) throw new Error("The waiver could not be recorded.");
  return at;
}
