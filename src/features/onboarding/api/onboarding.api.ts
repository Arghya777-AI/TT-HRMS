/**
 * onboarding.api.ts — what a new joiner still owes, and the two writes that close it.
 *
 * THE REQUIREMENT LIST IS THE SERVER'S. `v_my_onboarding_pack` is the union of the fields
 * HR configured for onboarding and the document types required at onboarding, each with
 * `is_required` and `is_done`. This module reads it and renders it; it never decides what
 * is required, because `submit_onboarding()` re-checks the same SQL. If the client held an
 * opinion the two could disagree, and the one that mattered would be the weaker.
 *
 * `submit_onboarding` raises `onboarding_incomplete: CODE, CODE` when something is still
 * outstanding. That list is parsed and handed back so the form can point at the exact
 * rows, rather than saying "something is missing" and leaving the reader to hunt.
 */
import { z } from "zod";
import { rpcOne, selectMany } from "@/shared/api/query";

export const ONBOARDING_PACK_VIEW = "v_my_onboarding_pack";

export const packItemSchema = z.object({
  kind: z.enum(["field", "document"]),
  code: z.string(),
  label: z.string(),
  help_text: z.string().nullable(),
  field_type: z.string(),
  options: z.unknown().nullable(),
  is_required: z.boolean(),
  section: z.string().nullable(),
  sort_order: z.number().nullable(),
  is_done: z.boolean(),
  document_id: z.string().uuid().nullable(),
});

export type PackItem = z.infer<typeof packItemSchema>;

export async function fetchOnboardingPack(signal?: AbortSignal): Promise<PackItem[]> {
  return selectMany(ONBOARDING_PACK_VIEW, packItemSchema, {
    // Required first, then the server's own ordering — so the blocking items are the ones
    // a reader sees without scrolling.
    order: [
      { column: "is_required", ascending: false },
      { column: "sort_order", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** The codes still outstanding, pulled out of the server's own refusal. */
export class OnboardingIncomplete extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`Onboarding is incomplete: ${missing.join(", ")}`);
    this.name = "OnboardingIncomplete";
    this.missing = missing;
  }
}

const INCOMPLETE = /onboarding_incomplete:\s*(.+)$/;

/**
 * Close onboarding. Resolves with the instant access was granted.
 *
 * A refusal is translated into `OnboardingIncomplete` carrying the codes, so the caller can
 * highlight rows instead of showing a database sentence to a new joiner on their first day.
 */
export async function submitOnboarding(signal?: AbortSignal): Promise<string> {
  try {
    const at = await rpcOne("submit_onboarding", {}, z.string(), {
      ...(signal ? { signal } : {}),
    });
    if (at === null) throw new Error("Onboarding could not be submitted.");
    return at;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = INCOMPLETE.exec(message);
    if (match?.[1] !== undefined) {
      throw new OnboardingIncomplete(match[1].split(",").map((c) => c.trim()).filter(Boolean));
    }
    throw error;
  }
}

/**
 * Has this person's onboarding already been dealt with?
 *
 * WHY THE WIZARD NEEDS TO ASK. `FirstRunGate` fires on `must_change_password ||
 * profile_confirmed_at IS NULL`, and the wizard's last step renders the document pack
 * unconditionally — so an employee whose onboarding HR has already WAIVED was still shown
 * "Required — 0 of 5 done" and asked for an Aadhaar card on every visit. The waiver said one
 * thing and the screen said another, and the screen wins with the reader.
 *
 * `waived` and `submitted` are returned separately because they are different facts. Waived
 * means HR decided the paperwork does not apply; submitted means the person supplied it.
 * Either one means the pack has nothing left to ask, which is what the wizard acts on.
 *
 * `onboarding__self_read` is the policy behind this, so it can only ever answer for the
 * caller. A missing row is not an error — it is somebody who has not started.
 */
export async function fetchMyOnboardingStatus(
  signal?: AbortSignal,
): Promise<{ submitted: boolean; waived: boolean }> {
  const rows = await selectMany(
    "employee_onboarding",
    z.object({
      submitted_at: z.string().nullable(),
      waived_at: z.string().nullable(),
    }),
    {
      columns: "submitted_at, waived_at",
      limit: 1,
      ...(signal ? { signal } : {}),
    },
  );
  const row = rows[0];
  return {
    submitted: row?.submitted_at !== null && row?.submitted_at !== undefined,
    waived: row?.waived_at !== null && row?.waived_at !== undefined,
  };
}
