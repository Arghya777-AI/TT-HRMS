/**
 * overtimeRules.api.ts — the numbers behind "how was my overtime worked out", and
 * "why did that Sunday become half a comp-off day".
 *
 * WHY THIS IS A READ AND NOT A PARAGRAPH OF COPY. Both formulas are real, both live in
 * `fn_rollup_attendance_day` and `fn_rollup_comp_off`, and both are driven by columns an
 * administrator can change per policy and per shift. Hard-coding "4 hours earns half a
 * day" into a sentence would be correct today at this venue and quietly wrong the moment
 * somebody edits the policy — which is exactly the class of defect the rest of this
 * codebase refuses. So the screen states the SHAPE of the rule and reads the NUMBERS
 * from the same rows the engine uses.
 *
 * WHERE EACH NUMBER LIVES, because they are deliberately not in one table:
 *
 *   attendance_policies   overtime_enabled, overtime_min_minutes,
 *                         overtime_rounding_minutes, max_overtime_minutes_per_day,
 *                         comp_off_min_minutes, comp_off_full_day_minutes,
 *                         comp_off_expiry_days
 *   shifts                ot_threshold_minutes, duration_minutes, grace_in_minutes
 *   employees             is_ot_eligible
 *   designations          ot_eligible
 *
 * `ot_threshold_minutes` sitting on the SHIFT rather than the policy is a correction the
 * engine's own header records (migration 018): the reference product had it on the
 * policy. A banquet shift and a general shift can carry different thresholds, and the
 * threshold is a property of the shift's shape, not of the attendance rules.
 *
 * BOTH TABLES ARE READABLE BY THE EMPLOYEE THEMSELVES. `attendance_policies__ref_read`
 * and `shifts__ref_read` both admit `is_active AND deleted_at IS NULL` to any
 * authenticated caller, so this needs no new grant and no edge function — an employee is
 * allowed to know the rules they are measured against.
 */
import { z } from "zod";
import { dbInt, dbIntNullable, dbUuid, eq, rpcOne, selectOne } from "@/shared/api/query";

export const ATTENDANCE_POLICIES_TABLE = "attendance_policies";
export const SHIFTS_TABLE = "shifts";
export const RESOLVE_POLICY_FN = "resolve_policy";

export const overtimePolicySchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  /** When false the engine never writes a single overtime minute for this policy. */
  overtime_enabled: z.boolean(),
  /** Below this, the surplus is discarded rather than rounded up. */
  overtime_min_minutes: dbInt,
  /** The surplus is rounded DOWN to a multiple of this. */
  overtime_rounding_minutes: dbInt,
  max_overtime_minutes_per_day: dbInt,
  /** Comp-off is earned from extra work on an off day, not from overtime. */
  comp_off_min_minutes: dbInt,
  comp_off_full_day_minutes: dbInt,
  comp_off_expiry_days: dbInt,
});

export type OvertimePolicy = z.infer<typeof overtimePolicySchema>;

export const overtimeShiftSchema = z.object({
  id: dbUuid,
  name: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  duration_minutes: dbInt,
  /** Worked minutes past the shift are ignored until they exceed this. */
  ot_threshold_minutes: dbInt,
  grace_in_minutes: dbIntNullable,
  grace_out_minutes: dbIntNullable,
});

export type OvertimeShift = z.infer<typeof overtimeShiftSchema>;

const POLICY_COLUMNS =
  "id, code, name, overtime_enabled, overtime_min_minutes, overtime_rounding_minutes, " +
  "max_overtime_minutes_per_day, comp_off_min_minutes, comp_off_full_day_minutes, " +
  "comp_off_expiry_days";

const SHIFT_COLUMNS =
  "id, name, start_time, end_time, duration_minutes, ot_threshold_minutes, " +
  "grace_in_minutes, grace_out_minutes";

export interface OvertimeRules {
  readonly policy: OvertimePolicy | null;
  readonly shift: OvertimeShift | null;
}

/**
 * The rules in force for this employee on this date.
 *
 * The policy is resolved through the SAME `resolve_policy` the engine calls, so the
 * screen cannot show one policy's numbers while the rollup applies another's — that
 * function walks employee → designation → grade → section → department → location →
 * company, and reimplementing the walk in the browser is how the two drift apart.
 *
 * Either half may be `null` and the caller must render that rather than a zero: no
 * resolvable policy means the engine used its own defaults, and no shift means overtime
 * cannot be computed for this person at all (`sh.id IS NOT NULL` guards the branch).
 */
export async function fetchMyOvertimeRules(
  employeeId: string,
  isoDate: string,
  shiftId: string | null,
  signal?: AbortSignal,
): Promise<OvertimeRules> {
  const policyId = await rpcOne(
    RESOLVE_POLICY_FN,
    { p_kind: "attendance_policy", p_employee_id: employeeId, p_date: isoDate },
    z.string().uuid().nullable(),
    signal ? { signal } : {},
  );

  const policy =
    policyId === null
      ? null
      : await selectOne(ATTENDANCE_POLICIES_TABLE, overtimePolicySchema, [eq("id", policyId)], {
          columns: POLICY_COLUMNS,
          ...(signal ? { signal } : {}),
        });

  const shift =
    shiftId === null
      ? null
      : await selectOne(SHIFTS_TABLE, overtimeShiftSchema, [eq("id", shiftId)], {
          columns: SHIFT_COLUMNS,
          ...(signal ? { signal } : {}),
        });

  return { policy, shift };
}

/**
 * The overtime formula, as the engine runs it, with this employee's numbers in it.
 *
 * Returned as parts rather than a sentence so the screen can lay it out as an equation
 * and the test can assert on the arithmetic. `surplus` is what the engine calls
 * `v_ot` before rounding.
 *
 * MIRRORS `fn_rollup_attendance_day` step 10 (migration 037600, which corrected 018):
 *
 *     ot = payable_worked − shift_duration − shift.ot_threshold
 *     ot < policy.overtime_min      → 0
 *     otherwise  floor(ot / rounding) × rounding,  capped at max_per_day
 *
 * On a holiday or a weekly off the engine takes a DIFFERENT branch entirely: the whole
 * payable span becomes `extra_work_minutes` and overtime stays zero. That is the branch
 * comp-off is earned from, and conflating the two is the single most likely
 * misunderstanding on this screen — hence `isOffDay`.
 */
export function overtimeFor(
  payableWorkedMinutes: number,
  rules: OvertimeRules,
  isOffDay: boolean,
): {
  readonly eligible: boolean;
  readonly surplus: number;
  readonly minutes: number;
  readonly reason: "off_day" | "no_shift" | "disabled" | "below_minimum" | "counted";
} {
  if (isOffDay) {
    return { eligible: false, surplus: 0, minutes: 0, reason: "off_day" };
  }
  if (rules.shift === null) {
    return { eligible: false, surplus: 0, minutes: 0, reason: "no_shift" };
  }
  if (rules.policy !== null && !rules.policy.overtime_enabled) {
    return { eligible: false, surplus: 0, minutes: 0, reason: "disabled" };
  }

  const minMinutes = rules.policy?.overtime_min_minutes ?? 0;
  const rounding = Math.max(rules.policy?.overtime_rounding_minutes ?? 1, 1);
  const cap = rules.policy?.max_overtime_minutes_per_day ?? Number.MAX_SAFE_INTEGER;

  const surplus =
    payableWorkedMinutes - rules.shift.duration_minutes - rules.shift.ot_threshold_minutes;
  if (surplus < minMinutes) {
    return { eligible: true, surplus: Math.max(surplus, 0), minutes: 0, reason: "below_minimum" };
  }
  return {
    eligible: true,
    surplus,
    minutes: Math.min(Math.floor(surplus / rounding) * rounding, cap),
    reason: "counted",
  };
}

/**
 * What a day of extra work on an off day earns, as `fn_rollup_comp_off` decides it.
 *
 * Half a day or a whole one — there is no third answer and no pro-rata. Below the
 * minimum it earns nothing, which is worth saying out loud on the screen: somebody who
 * came in for two hours on their weekly off has earned no comp-off, and finding that out
 * from a missing credit weeks later is how trust in the number goes.
 */
export function compOffDaysFor(
  extraWorkMinutes: number,
  rules: OvertimeRules,
): { readonly days: number; readonly reason: "below_minimum" | "half" | "full" } {
  const min = rules.policy?.comp_off_min_minutes ?? 240;
  const full = rules.policy?.comp_off_full_day_minutes ?? 480;
  if (extraWorkMinutes < min) return { days: 0, reason: "below_minimum" };
  if (extraWorkMinutes >= full) return { days: 1, reason: "full" };
  return { days: 0.5, reason: "half" };
}
