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
const dialog = strip(read("src", "features", "admin", "components", "CancelLeaveDaysDialog.tsx"));
const band = strip(read("src", "features", "admin", "components", "LeaveCalendarBand.tsx"));
const daysSql = strip(
  read("supabase", "migrations", "20260906180000_a_leave_can_be_taken_back_a_day_at_a_time.sql"),
);
const editSql = strip(
  read("supabase", "migrations", "20260906210000_an_approved_leave_can_be_edited_or_handed_back.sql"),
);

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
    expect(queue).toContain("setCancelTarget({");
    expect(queue).toContain("<CancelLeaveDaysDialog");
  });

  it("offers it per person on the leave calendar's day list", () => {
    // "by clicking on that particular day/section ... there will be options".
    expect(cal).toContain('row.status === "approved" && profileId !== null');
    expect(cal).toContain("setTarget({");
    expect(cal).toContain("<CancelLeaveDaysDialog");
  });

  it("does not offer it on a PENDING row from the calendar", () => {
    /*
      A pending request is decided in the queue. A quiet "cancel" here would be a second way
      to refuse something without it reading as a rejection to the person who asked.
    */
    expect(cal).not.toContain('row.status === "pending"');
  });

  it("makes every name in the Command Centre day popover a button", () => {
    /*
      THE ONE THAT WAS MISSED. The Command Centre's calendar band is a DIFFERENT component
      from the full leave calendar, and wiring one left the other a read-only list — which is
      the screen an administrator actually looks at first.
    */
    expect(band).toContain('const actionable = row.status === "approved";');
    expect(band).toContain("setCancelTarget({");
    expect(band).toContain("<CancelLeaveDaysDialog");
  });

  it("leaves a pending row unclickable in the Command Centre too", () => {
    /*
      Decided in the queue, where refusing reads as a rejection. Asserted on the BUTTON, not
      on `{actionable ? (` — that appears twice, once for the chevron, so a check on the bare
      ternary passes while the row is a plain span.
    */
    expect(band).toMatch(/\{actionable \? \(\s*<button/);
    expect(band).toContain("<span className=\"flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2\">");
  });

  it("opens the SAME dialog from all three screens", () => {
    // Two routes to one record is how screens end up disagreeing; three is worse.
    expect(queue).toContain('from "../components/CancelLeaveDaysDialog"');
    expect(cal).toContain('from "../components/CancelLeaveDaysDialog"');
    expect(band).toContain('from "./CancelLeaveDaysDialog"');
  });

  it("asks for a reason before acting on a click", () => {
    expect(dialog).toContain("SENSITIVE_REASON_LENGTH");
    expect(dialog).toContain("reason.trim().length >= SENSITIVE_REASON_LENGTH");
  });

  it("shows the function's refusal instead of swallowing it", () => {
    // "locked period", "already paid", "comp-off is booked whole" — each names a next step.
    expect(dialog).toContain("cancel.userMessage");
  });
});

describe("it opens read-only, and Cancel is a second press", () => {
  it("starts on the view step every time it opens", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. Clicking a name on a calendar means "show me this".
      Opening straight into a form with every box already ticked is how somebody cancels a
      leave they only meant to read.
    */
    // Four steps now — view, cancel, edit, sendBack — and it always opens on the first.
    expect(dialog).toMatch(/useState<"view" \| "cancel" \| "edit" \| "sendBack">\("view"\)/);
    expect(dialog).toContain('setStep("view");');
  });

  it("shows no checkboxes while you are only looking", () => {
    expect(dialog).toContain('{step === "cancel" ? (\n                        <input');
  });

  it("asks for no reason and shows no warning while you are only looking", () => {
    /*
      The reason box appears for EVERY acting step — cancel, edit and send-back all ask why —
      and for none of them while the dialog is read-only.
    */
    expect(dialog).toContain('{step !== "view" ? (');
    expect(dialog).toContain('{step === "cancel" && needsAck ? (');
  });

  it("offers Cancel as the way out of read-only, and Back as the way in", () => {
    expect(dialog).toContain('onClick={() => setStep("cancel")}');
    expect(dialog).toContain('onClick={() => setStep("view")}');
  });

  it("cannot start a cancellation on a leave with nothing left to cancel", () => {
    expect(dialog).toContain("disabled={cancellable.length === 0}");
  });
});

describe("picking which days", () => {
  it("ticks every cancellable day, because the whole booking is the ordinary case", () => {
    expect(dialog).toContain("setPicked(cancellable.map((d) => d.leave_date));");
  });

  it("cannot re-pick a day that is already cancelled", () => {
    expect(dialog).toContain('(days.data ?? []).filter((d) => d.status === "approved")');
    expect(dialog).toContain("disabled={done}");
  });

  it("shows a holiday or weekly off rather than hiding it", () => {
    /*
      Those rows are part of the booking and cost no balance. A three-day request spanning a
      Sunday is three rows on the calendar; showing two here reads as a lost day.
    */
    expect(dialog).toContain("adminLeave.cancelDays.holiday");
    expect(dialog).toContain("adminLeave.cancelDays.weeklyOff");
    expect(dialog).toContain("free ? \"—\" : Number(d.day_value).toFixed(2)");
  });

  it("counts only counted days toward what is released", () => {
    expect(dialog).toContain("(d.is_counted ? Number(d.day_value) : 0)");
  });
});

describe("a day that has already passed is warned about", () => {
  it("warns only for past dates, and names them", () => {
    // THE REGRESSION THIS EXISTS FOR: cancelling a future leave is planning; cancelling a
    // past one rewrites an attendance record for a day people may already have acted on.
    expect(dialog).toContain("const pastPicked = picked.filter((d) => d < today);");
    expect(dialog).toContain("const needsAck = pastPicked.length > 0;");
    expect(dialog).toContain('t("adminLeave.cancelDays.pastWarning"');
  });

  it("blocks the button until it is acknowledged", () => {
    expect(dialog).toContain("(!needsAck || acknowledged)");
  });

  it("compares against the VENUE'S day, not the browser's", () => {
    /*
      `new Date()` on a laptop in another timezone would call the same morning "past" in one
      place and "future" in another, on the same record.
    */
    expect(dialog).toContain("const today = istToday();");
    expect(dialog).not.toContain("new Date()");
  });

  it("re-arms the acknowledgement for every request", () => {
    // An acknowledgement is for the days in front of you, not a setting.
    expect(dialog).toContain("setAcknowledged(false);");
  });
});

describe("the per-day function keeps the ledger honest", () => {
  it("closes the old debit whole and opens a new one for the remainder", () => {
    /*
      THE BUG THIS EXISTS FOR. A first draft wrote a +1 reversal against a -3 debit and left
      the debit un-reversed, so when the last two days were cancelled the status trigger —
      which reverses every un-reversed `availed` row — returned another 3. Four days back
      from a three-day booking. Verified live after the fix: the ledger reads
      -3, +3, -2, +2 and nets to exactly zero.
    */
    expect(daysSql).toContain("ll.entry_type = 'availed'");
    expect(daysSql).toContain("ll.reversed_by_id IS NULL");
    expect(daysSql).toContain("UPDATE public.leave_ledger SET reversed_by_id = v_rev_id");
    expect(daysSql).toContain("'availed', -v_still");
  });

  it("hands a fully-emptied request back to the status trigger", () => {
    // And writes no partial entry on that path, or the trigger would reverse it twice.
    expect(daysSql).toContain("IF v_left = 0 THEN");
    expect(daysSql).toContain("SET status              = 'cancelled',");
  });

  it("releases each day's own value, so a half day releases a half", () => {
    expect(daysSql).toContain("COALESCE(sum(ld.day_value), 0)");
  });

  it("refuses a date that is not in the request", () => {
    expect(daysSql).toContain("is not a day of request");
  });

  it("refuses to split a comp-off booking", () => {
    // A credit is consumed as a unit against a specific earned day.
    expect(daysSql).toContain("Comp-off is booked as a whole");
  });

  it("keeps paid and unpaid within the days constraint", () => {
    // ck_lr__days requires paid + unpaid <= total; shrinking total alone is refused.
    expect(daysSql).toContain("paid_days     = GREATEST(0, LEAST(paid_days - v_release, v_left))");
  });
});

describe("changing the dates, and handing it back", () => {
  it("offers all three from the read-only view", () => {
    // "The option should be given everywhere where the Cancel button is."
    expect(dialog).toContain('onClick={() => setStep("edit")}');
    expect(dialog).toContain('onClick={() => setStep("sendBack")}');
    expect(dialog).toContain('onClick={() => setStep("cancel")}');
  });

  it("styles only the destructive one destructively", () => {
    /*
      Changing dates and handing it back are both reversible; cancelling releases the days and
      rewrites the attendance record. The colours should not say they are the same act.
    */
    const view = dialog.slice(dialog.indexOf('step === "view" ? ('), dialog.indexOf('") : step === "edit"'));
    expect(view).toContain('variant="outline"');
    expect(view).toContain('variant="destructive"');
  });

  it("asks for a reason on every one of them", () => {
    expect(dialog).toContain('{step !== "view" ? (');
  });

  it("surfaces whichever refusal came back", () => {
    // A locked period refuses all three, and the message names what to do about it.
    expect(dialog).toContain("cancel.userMessage ?? edit.userMessage ?? sendBack.userMessage");
  });

  it("refuses a range that ends before it starts, in the form and the function", () => {
    expect(dialog).toContain("editTo < editFrom");
    expect(editSql).toContain("The last day cannot be before the first.");
  });
});

describe("un-approving reverses, whatever it is un-approved to", () => {
  it("teaches the trigger the word 'pending'", () => {
    /*
      THE GAP THIS CLOSES. The trigger reversed on approved -> cancelled/rejected/withdrawn
      and NOT on approved -> pending. Handing a leave back therefore left the debit standing
      while the request sat pending; a later withdrawal reversed nothing, because OLD.status
      was no longer 'approved'. An orphaned debit and a permanently short balance.
    */
    expect(editSql).toContain("NEW.status IN ('cancelled','rejected','withdrawn','pending')");
  });

  it("clears the approver from a request that is no longer approved", () => {
    // Their name on it would read, months later, as approving whatever it became.
    expect(editSql).toContain("decided_by          = NULL");
    expect(editSql).toContain("decided_at          = NULL");
  });

  it("edits by un-applying and re-applying, never by writing a ledger row itself", () => {
    expect(editSql).toContain("UPDATE public.leave_requests SET status = 'pending' WHERE id = r.id;");
    expect(editSql).toContain("public.rebuild_leave_request_days(");
    expect(editSql).toContain("UPDATE public.leave_requests SET status = 'approved' WHERE id = r.id;");
  });

  it("checks the balance itself, because nothing else will", () => {
    /*
      `leave_requests_submit_guard` fires only when a DRAFT becomes pending, so an edit
      stretching two days to ten would otherwise pass every balance rule in the system.
    */
    expect(editSql).toContain("has % available. The change was not applied.");
  });

  it("checks locks and payroll over the OLD range as well as the new", () => {
    // Moving a leave OUT of a settled week changes that week too.
    expect(editSql).toContain("daterange(v_old_from, v_old_to, '[]')");
    expect(editSql).toContain("d2.ist_date BETWEEN v_old_from AND v_old_to OR d2.ist_date BETWEEN p_from AND p_to");
  });

  it("recomputes every day that changed meaning, released and taken", () => {
    expect(editSql).toContain("LEAST(v_old_from, p_from), GREATEST(v_old_to, p_to)");
  });

  it("refuses to move a comp-off booking", () => {
    // It is booked against specific earned credits; moving it is a different request.
    expect(editSql).toContain("Comp-off is booked against specific earned credits");
  });
});
