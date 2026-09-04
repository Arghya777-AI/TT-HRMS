/**
 * Taking back an approved leave — the door, and the three things it refuses.
 *
 * ── WHAT WAS THERE, AND WHAT WAS NOT ─────────────────────────────────────────
 * Once a leave was approved there was no way back on any screen. `withdrawLeaveRequest`
 * covers `draft|pending -> withdrawn` for the owner and stops; a week-off approved by mistake
 * could only be fixed by editing the database by hand.
 *
 * Most of the machinery already existed and is untouched. `leave_requests_apply_ledger`
 * already reverses on `approved -> cancelled`: an `availed_reversal` against every un-reversed
 * debit, comp-off credits restored unless expired, per-day rows reset, `ledger_applied_at`
 * cleared. The enum already had `cancelled`. `leave_requests__admin_all` already granted the
 * row. There was even a `cancelLeaveRequest` API and a `useCancelLeaveRequest` hook — and NO
 * SCREEN CALLED EITHER, so the capability existed and could not be reached.
 *
 * ── THE PART THAT WAS ACTUALLY DANGEROUS ─────────────────────────────────────
 * That API was a bare `updateRow` filtered on `[eq("id", requestId)]` and nothing else. It
 * leaned entirely on RLS, which answers "may this administrator touch this employee" and
 * cannot answer "is this leave safe to take back". Three silent failures followed:
 *
 *   · cancelling something not approved wrote a status change and reversed NOTHING, because
 *     the reversal trigger only fires on approved -> cancelled;
 *   · cancelling inside a hard attendance lock rewrote a settled period;
 *   · cancelling a leave already carried into payroll credited the balance back while the
 *     payslip that consumed it stayed as it was — and the two never agreed again.
 *
 * `admin_cancel_leave_request` refuses all three by name. Verified against the live database
 * on a real approved request, rolled back: balance 5.000 -> 6.000, one `availed_reversal`
 * row, `ledger_applied_at` cleared, day rows `cancelled`, a short reason refused, and a second
 * cancel refused with "this request is cancelled, not approved".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const sql = read("supabase", "migrations", "20260906090000_an_approved_leave_can_be_taken_back.sql");
const api = strip(read("src", "features", "admin", "api", "leave.api.ts"));
const hook = strip(read("src", "features", "admin", "hooks", "useAdminLeave.ts"));
const queue = strip(read("src", "features", "admin", "pages", "LeaveRequests.page.tsx"));
const cal = strip(read("src", "features", "admin", "pages", "OrgLeaveCalendar.page.tsx"));

describe("only an administrator, and only an approved request", () => {
  it("re-asserts admin and scope inside the definer", () => {
    /*
      SECURITY DEFINER runs as the owner, so RLS does not apply inside it. Without this the
      function would be a hole straight through `leave_requests__admin_all`.
    */
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("NOT (app.is_admin() AND app.admin_scope_covers(r.employee_id))");
  });

  it("refuses a request that is not approved", () => {
    // THE SILENT ONE: the reversal trigger fires only on approved -> cancelled.
    expect(sql).toContain("r.status NOT IN ('approved', 'partially_approved')");
    expect(sql).toContain("there is nothing to cancel");
  });

  it("demands a reason the employee will read", () => {
    expect(sql).toContain("length(v_reason) < 10");
  });

  it("is executable by a signed-in user and nobody else", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.admin_cancel_leave_request(uuid, text) FROM PUBLIC;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.admin_cancel_leave_request(uuid, text) TO authenticated;");
  });
});

describe("the two states where cancelling would do damage", () => {
  it("refuses inside a hard attendance lock, and names it", () => {
    expect(sql).toContain("al.lock_kind = 'hard'");
    expect(sql).toContain("daterange(al.from_date, al.to_date, '[]') && daterange(r.from_date, r.to_date, '[]')");
    expect(sql).toContain("Unlock the period before cancelling this leave");
  });

  it("refuses once the days have reached a payroll run", () => {
    // Otherwise the balance goes up and the payslip that consumed it does not.
    expect(sql).toContain("d.payroll_run_id IS NOT NULL");
    expect(sql).toContain("already carried into a payroll run");
  });

  it("checks the locks against every scope a lock can have", () => {
    for (const scope of ["company", "employee", "department", "location"]) {
      expect(sql, scope).toContain(`al.scope = '${scope}'`);
    }
  });
});

describe("it does the one write and lets the triggers do the rest", () => {
  it("changes the status and nothing else about the ledger", () => {
    /*
      The reversal, the comp-off restoration and the attendance recompute already ride on
      triggers. Reimplementing any of them here would be a second copy to drift.
    */
    expect(sql).toContain("SET status              = 'cancelled'");
    expect(sql).not.toContain("INSERT INTO public.leave_ledger");
    expect(sql).not.toContain("UPDATE public.leave_balances");
  });

  it("records who took it back and why", () => {
    expect(sql).toContain("cancelled_by        = v_actor");
    expect(sql).toContain("cancellation_reason = v_reason");
  });
});

describe("the client goes through that door, not around it", () => {
  it("calls the guarded function instead of updating the table", () => {
    // THE REGRESSION THIS EXISTS FOR: it was `updateRow(LEAVE_REQUESTS_TABLE, [eq("id", …)])`.
    expect(api).toContain('rpcAudited(\n    "admin_cancel_leave_request"');
    const fn = api.slice(api.indexOf("export async function cancelLeaveRequest"));
    expect(fn.slice(0, 900)).not.toContain("updateRow(");
  });

  it("refreshes attendance as well as leave", () => {
    // Cancelling a leave day re-derives that day; a stale roster would contradict the balance.
    expect(hook).toContain("qk.admin.attendanceAll()");
    expect(hook).toContain("qk.attendance.all");
  });
});

describe("where an administrator can reach it", () => {
  it("offers it on an approved row in the requests queue", () => {
    expect(queue).toContain('row.status === "approved" || row.status === "partially_approved"');
    expect(queue).toContain('decision: "cancelled"');
  });

  it("offers it per person on the leave calendar's day list", () => {
    // "by clicking on that particular day/section ... there will be options".
    expect(cal).toContain('row.status === "approved" && profileId !== null');
    expect(cal).toContain("useCancelLeaveRequest");
  });

  it("does not offer it on a PENDING row from the calendar", () => {
    /*
      A pending request is decided in the queue. A quiet "cancel" here would be a second way
      to refuse something without it reading as a rejection to the person who asked.
    */
    expect(cal).not.toContain('row.status === "pending"');
  });

  it("asks for a reason on both screens rather than acting on a click", () => {
    expect(queue).toContain("<ReasonDialog");
    expect(cal).toContain("<ReasonDialog");
    expect(queue).toContain("SENSITIVE_REASON_LENGTH");
    expect(cal).toContain("SENSITIVE_REASON_LENGTH");
  });

  it("shows the function's refusal instead of swallowing it", () => {
    // "locked period", "already paid" — each names something the admin must go and do.
    expect(queue).toContain("cancel.userMessage");
    expect(cal).toContain("errorMessage={cancel.userMessage}");
  });
});
