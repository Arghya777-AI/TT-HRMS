/**
 * leave-on-behalf.api.ts — an administrator applying for leave FOR an employee.
 *
 * WHY ALMOST NOTHING NEW IS NEEDED, and it is worth saying because it shaped the whole
 * approach. `leave_requests__admin_all` is `FOR ALL` with
 * `app.is_admin() AND app.admin_scope_covers(employee_id)` on both USING and CHECK, so an
 * admin has always been able to insert and submit a request for anybody in their scope.
 * And `previewLeaveRequest` / `submitLeaveRequest` were already parameterised by
 * `employeeId` and `requestId` rather than assuming the caller. The gap was entirely that
 * no screen let an admin choose the employee.
 *
 * So this module adds ONE read and reuses the employee's own write path. Duplicating the
 * preview or the submit would be a second implementation of a flow guarded by five
 * triggers, and the copy would drift from the one employees use — which is exactly how an
 * admin-created request starts behaving differently from a self-created one.
 *
 * WHAT THE SERVER ENFORCES, verified against the live project by submitting a real request
 * for employee 005 as admin Priya (then rolling back). Every one of these is a
 * `leave_requests_submit_guard` refusal, not a client rule:
 *
 *   * a minimum request size per leave type — a range that expands to 0 counted days is
 *     refused ("leave type EL requires at least 0.50")
 *   * `handover_to_employee_id` is MANDATORY for operational departments
 *   * sufficient paid balance, or the overflow explicitly marked unpaid
 *   * no overlap with an existing request (`leave_requests_no_overlap`)
 *   * a reason of at least 10 characters (`ck_lr__reason`)
 *
 * The form therefore offers a handover picker and an unpaid-overflow field, because
 * without them a well-formed request is refused for reasons an admin cannot see.
 *
 * THE REQUEST IS `pending`, NOT PRE-APPROVED. An admin applying on somebody's behalf is
 * still making a request, and it still goes to the approver. Inserting it as `approved`
 * would skip the approval trail and leave a leave balance that moved with nobody's name
 * against the decision.
 */
import { z } from "zod";
import { dbDateNullable, dbUuid, dbUuidNullable, eq, selectOne } from "@/shared/api/query";
import { V_ADMIN_EMPLOYEE } from "./employees.api";
import type { MyLeaveContext } from "@/features/leave/api/leave-apply.api";

/**
 * The same shape `fetchMyLeaveContext` returns, read for SOMEBODY ELSE.
 *
 * `v_my_employee` is pinned to `app.current_employee_id()` and cannot answer about another
 * person, so this reads `v_admin_employee` — which carries every one of these columns and
 * is already scoped by `app.is_admin() AND app.admin_scope_covers()`. An admin therefore
 * cannot fetch context for somebody their own directory would not show them, and no new
 * grant is involved.
 */
export const employeeLeaveContextSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  employment_status: z.string(),
  employment_type: z.string(),
  gender: z.string().nullable(),
  date_of_join: dbDateNullable,
  confirmation_due_date: dbDateNullable,
  confirmed_on: dbDateNullable,
  holiday_calendar_id: dbUuidNullable,
  weekly_off_rule_id: dbUuidNullable,
  department_id: dbUuidNullable,
  mobile: z.string().nullable(),
});

const CONTEXT_COLUMNS =
  "id, employee_code, display_name, employment_status, employment_type, gender, " +
  "date_of_join, confirmation_due_date, confirmed_on, holiday_calendar_id, " +
  "weekly_off_rule_id, department_id, mobile";

/**
 * The employment facts that decide which leave types may be offered for this employee.
 *
 * Returns the SAME type as the self path so `isEligibleLeaveType` and
 * `isProbationLocked` can be reused verbatim — the eligibility rules mirror
 * `leave_requests_submit_guard`, and having two copies of them is how the admin form
 * starts offering a type the server refuses.
 */
export async function fetchEmployeeLeaveContext(
  employeeId: string,
  signal?: AbortSignal,
): Promise<MyLeaveContext | null> {
  return selectOne(V_ADMIN_EMPLOYEE, employeeLeaveContextSchema, [eq("id", employeeId)], {
    columns: CONTEXT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}
