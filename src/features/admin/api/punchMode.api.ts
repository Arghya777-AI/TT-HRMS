/**
 * punchMode.api.ts — how an employee's hours are counted.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SETTING ACTUALLY DECIDES
 *
 * A day with scans at 07:36, 07:38, 14:18, 22:12 and 22:15 reported FIVE MINUTES worked
 * before this was exposed. The span was never wrong — the engine takes `min(punched_at)`
 * to `max(punched_at)`, which was 14h39m — but under `multi_punch` every INTERIOR gap of
 * at least `min_break_minutes_to_count` is an unpaid break, and the two interior gaps
 * were 400 and 474 minutes. 879 − 874 = 5. The engine did exactly what it was told.
 *
 *   single_punch  the day is FIRST SCAN → LAST SCAN. Interior scans are noise: a guard
 *                 tapping the gate at lunch does not shorten the shift. Only an explicit
 *                 break pair is deducted, plus the shift's fixed unpaid break if the
 *                 policy sets one.
 *   multi_punch   scans are in/out pairs and the gaps between them are unpaid. Correct
 *                 for staff who genuinely clock out and back in.
 *
 * Both are legitimate. The enum has held both values since migration 003; what was
 * missing was any way for an admin to choose, so everybody sat on `multi_punch`.
 *
 * ADMIN ONLY, AND NARROWER THAN THE FACE-LOGIN SWITCH. An employee may flip their own
 * face sign-in because it governs their own credential. This governs what they are PAID,
 * so neither they nor their manager may set it — `set_punch_mode` enforces that in the
 * database and this module does not re-implement the rule.
 *
 * CHANGING IT DOES NOT REWRITE HISTORY. The mode is read by `compute_attendance_day`, so
 * days already computed keep their figures until a recompute runs. That is deliberate: a
 * dropdown must not silently restate three months of pay. `/admin/attendance/recompute`
 * is the deliberate way, and the UI says so.
 */
import { z } from "zod";
import { dbUuid, inList, rpcOne, selectMany } from "@/shared/api/query";

export const PUNCH_MODE_VIEW = "v_punch_mode_access";
export const SET_PUNCH_MODE_FN = "set_punch_mode";

export const punchModeValues = ["single_punch", "multi_punch"] as const;
export type PunchMode = (typeof punchModeValues)[number];

export const punchModeAccessSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  punch_mode: z.enum(punchModeValues),
  department_name: z.string().nullable(),
  /** TRUE only for a scoped admin — the database decides, not this client. */
  can_manage: z.boolean(),
});

export type PunchModeAccess = z.infer<typeof punchModeAccessSchema>;

export async function fetchPunchModes(
  employeeIds?: readonly string[],
  signal?: AbortSignal,
): Promise<PunchModeAccess[]> {
  return selectMany(PUNCH_MODE_VIEW, punchModeAccessSchema, {
    ...(employeeIds !== undefined && employeeIds.length > 0
      ? { filters: [inList("employee_id", [...employeeIds])] }
      : {}),
    order: [{ column: "display_name", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Set the mode. Returns the value the DATABASE settled on, so a UI reading the result
 * cannot drift from stored state.
 *
 * No `reason` argument: the function writes its own audit sentence, because it is the
 * only party that knows the change was made by an admin rather than by anybody else.
 */
export async function setPunchMode(
  employeeId: string,
  mode: PunchMode,
  signal?: AbortSignal,
): Promise<PunchMode> {
  const value = await rpcOne(
    SET_PUNCH_MODE_FN,
    { p_employee_id: employeeId, p_mode: mode },
    z.enum(punchModeValues),
    { ...(signal ? { signal } : {}) },
  );
  if (value === null) {
    throw new Error("The punch model could not be changed: that employee no longer exists.");
  }
  return value;
}
