/**
 * report-subjects.ts — turning a scheduled report's SUBJECT into an actual file.
 *
 * `scheduled_reports.subject` is a closed vocabulary of ten values. Until now they
 * were names in a dropdown: the register recorded that the muster should go out
 * every Monday, and nothing could produce a muster.
 *
 * This maps the subjects that CAN be rendered today onto the export engine, so an
 * administrator can download one now. That matters beyond convenience — a
 * schedule for a report nobody has ever seen is a schedule nobody can check, and
 * when delivery is eventually built it will be automating something already known
 * to work rather than something hoped to.
 *
 * ── FOUR OF TEN, AND THE OTHER SIX SAY WHY ──────────────────────────────────
 *
 * `exportReport` states its own boundary plainly, and it is not decoration: it
 * writes no `export_log` row, no content hash and no row count, so it is for
 * GOVERNED ANALYTICS OUTPUT the user is already looking at — never for statutory
 * registers, salary-bearing extracts, or a bulk dump of the employee master.
 * Those are a PII egress and belong behind a server function that writes the
 * register row in the same breath as it produces the file, so the two can never
 * disagree.
 *
 * So `payroll_register` and `payroll_statutory` are deliberately NOT renderable
 * here, and neither are the subjects that would amount to an employee-master dump.
 * Wiring them to this engine would be a one-line change and a real breach of the
 * line §14 draws, which is exactly why the refusal is written down rather than
 * left to whoever edits this next.
 *
 * ── EVERY ROW IS THE SERVER'S ───────────────────────────────────────────────
 *
 * Each renderer calls the SAME fetcher its screen uses, under the caller's own
 * RLS. Nothing is re-derived, re-sorted or re-totalled here — a file that
 * disagrees with the screen it was taken from is worse than no file.
 */
import { istToday } from "@/lib/datetime";
import { periodFor } from "@/lib/period";
import type { AnalyticsFilters } from "@/lib/analyticsFilters";
import type { ExportColumn } from "@/lib/exportReport";
import { fetchDayRecords, type DayRow } from "./attendance.api";
import { fetchCustody, type CustodyRow } from "./assets.api";
import { fetchCompliance, type ComplianceRow } from "./documents.api";
import { fetchApprovalRequests, type ApprovalRequestRow } from "./workflow-admin.api";
import { fetchExceptionQueue, type ExceptionRow } from "./attendance.api";
import { fetchHeadcountMonthly, type HeadcountMonthlyRow } from "./analytics-workforce.api";
import {
  fetchLeaveBalances,
  fetchLeaveRequests,
  type LeaveBalance,
  type LeaveRequest,
} from "./leave.api";
import type { ReportSubject } from "./scheduled-reports.api";

/** How many rows one download may carry. Stated, and stated on the file too. */
export const SUBJECT_ROW_CAP = 1000;

/**
 * A subject that can be turned into a file today.
 *
 * `rows` is deliberately `unknown[]` at the boundary and typed inside each
 * definition — the alternative is a discriminated union threaded through the
 * button, which buys nothing because the button only ever hands the pair straight
 * back to the export engine.
 */
export interface RenderableSubject {
  readonly subject: ReportSubject;
  readonly title: string;
  readonly filename: string;
  readonly load: (signal?: AbortSignal) => Promise<{
    readonly rows: readonly unknown[];
    readonly columns: readonly ExportColumn<never>[];
    readonly filters: AnalyticsFilters;
  }>;
}

/** A snapshot has no natural period; the engine still demands one, and says so. */
function today(): AnalyticsFilters {
  return { period: periodFor("day", istToday()), source: "all" };
}

const MUSTER_COLUMNS: readonly ExportColumn<DayRow>[] = [
  { key: "work_date", header: "Date" },
  { key: "employee_code", header: "Code" },
  { key: "display_name", header: "Name" },
  { key: "department_name", header: "Department" },
  { key: "status", header: "Status" },
  { key: "first_in_at", header: "First in" },
  { key: "last_out_at", header: "Last out" },
  { key: "payable_worked_minutes", header: "Worked (min)", align: "right" },
  { key: "late_minutes", header: "Late (min)", align: "right" },
];

const CUSTODY_COLUMNS: readonly ExportColumn<CustodyRow>[] = [
  { key: "employee_code", header: "Code" },
  { key: "employee_name", header: "Name" },
  { key: "asset_tag", header: "Tag" },
  { key: "asset_name", header: "Item" },
  { key: "allocated_at", header: "Held since" },
  { key: "expected_return_date", header: "Due back" },
];

const COMPLIANCE_COLUMNS: readonly ExportColumn<ComplianceRow>[] = [
  { key: "employee_code", header: "Code" },
  { key: "employee_name", header: "Name" },
  { key: "document_type_name", header: "Document" },
  { key: "compliance_status", header: "State" },
  { key: "expires_on", header: "Expires" },
];

/*
  Ids are NOT exported. `approval_requests` names its subject and its approvers by
  uuid, and a spreadsheet column of uuids is unreadable to the person who asked for
  the report while still being a list of who-is-who to anybody else it reaches.
  What a reader needs is the reference, what it is, and how long it has been
  sitting — all of which are on the row itself.
*/
const APPROVALS_COLUMNS: readonly ExportColumn<ApprovalRequestRow>[] = [
  { key: "request_number", header: "Reference" },
  { key: "title", header: "What it is" },
  { key: "status", header: "Status" },
  { key: "current_level", header: "Level", align: "right" },
  { key: "total_levels", header: "Of", align: "right" },
  { key: "priority", header: "Priority" },
  { key: "submitted_at", header: "Raised" },
  { key: "sla_due_at", header: "Due by" },
];

const EXCEPTIONS_COLUMNS: readonly ExportColumn<ExceptionRow>[] = [
  { key: "ist_date", header: "Date" },
  { key: "exception_kind", header: "Kind" },
  { key: "severity", header: "Severity" },
  { key: "description", header: "What happened" },
  { key: "occurred_at", header: "Raised" },
];

/*
  Balances, not entitlement policy. `available_after_pending` is the GENERATED
  column the screens headline and the submit guard checks, so the file carries the
  same figure rather than a sum of the components beside it — one number, from one
  expression, evaluated once in Postgres.
*/
const BALANCES_COLUMNS: readonly ExportColumn<LeaveBalance>[] = [
  { key: "leave_year", header: "Year", align: "right" },
  { key: "leave_type_code", header: "Type" },
  { key: "leave_type_name", header: "Leave" },
  { key: "entitlement_days", header: "Entitled", align: "right" },
  { key: "availed_days", header: "Used", align: "right" },
  { key: "pending_days", header: "Held", align: "right" },
  { key: "available_after_pending", header: "Available", align: "right" },
];

const LEAVE_TAKEN_COLUMNS: readonly ExportColumn<LeaveRequest>[] = [
  { key: "request_number", header: "Reference" },
  { key: "from_date", header: "From" },
  { key: "to_date", header: "To" },
  { key: "total_days", header: "Days", align: "right" },
  { key: "paid_days", header: "Paid", align: "right" },
  { key: "unpaid_days", header: "Unpaid", align: "right" },
  { key: "status", header: "Status" },
  { key: "decided_at", header: "Decided" },
];

/*
  HEADCOUNT IS AN AGGREGATE, AND THAT IS THE WHOLE POINT.

  The obvious reading of "headcount" is a list of everybody on roll — which is a
  bulk dump of the employee master, exactly what the export engine's header
  excludes. `v_headcount_monthly`'s grain is (year, month, department), so this
  file carries counts and movements and names nobody. It is also what a person
  asking for a headcount report actually wants: the shape of the workforce, not a
  directory they already have.
*/
const HEADCOUNT_COLUMNS: readonly ExportColumn<HeadcountMonthlyRow>[] = [
  { key: "year", header: "Year", align: "right" },
  { key: "month", header: "Month", align: "right" },
  { key: "department_name", header: "Department" },
  { key: "avg_headcount", header: "Average on roll", align: "right" },
  { key: "joiners", header: "Joined", align: "right" },
  { key: "exits", header: "Left", align: "right" },
];

/**
 * The subjects a browser may render, keyed by subject.
 *
 * Absent from this map = not renderable here, and the screen says so rather than
 * offering a button that fails or, worse, one that quietly exports something it
 * should not.
 */
export const RENDERABLE_SUBJECTS: Partial<Record<ReportSubject, RenderableSubject>> = {
  attendance_muster: {
    subject: "attendance_muster",
    title: "Attendance muster",
    filename: "attendance-muster",
    load: async (signal) => {
      /* Today's muster. `fetchDayRecords` is paginated; one page at the cap is
         the whole day for any venue this product is built for, and the row cap is
         printed on the file rather than silently truncating. */
      const page = await fetchDayRecords(
        { from: istToday(), to: istToday() },
        SUBJECT_ROW_CAP,
        null,
        signal,
      );
      return {
        rows: page.rows,
        columns: MUSTER_COLUMNS as readonly ExportColumn<never>[],
        filters: today(),
      };
    },
  },

  asset_custody: {
    subject: "asset_custody",
    title: "Asset custody",
    filename: "asset-custody",
    load: async (signal) => ({
      rows: await fetchCustody({}, signal),
      columns: CUSTODY_COLUMNS as readonly ExportColumn<never>[],
      filters: today(),
    }),
  },

  document_compliance: {
    subject: "document_compliance",
    title: "Document compliance",
    filename: "document-compliance",
    load: async (signal) => ({
      rows: await fetchCompliance({}, SUBJECT_ROW_CAP, signal),
      columns: COMPLIANCE_COLUMNS as readonly ExportColumn<never>[],
      filters: today(),
    }),
  },

  attendance_exceptions: {
    subject: "attendance_exceptions",
    title: "Attendance exceptions",
    filename: "attendance-exceptions",
    load: async (signal) => ({
      rows: await fetchExceptionQueue({}, SUBJECT_ROW_CAP, signal),
      columns: EXCEPTIONS_COLUMNS as readonly ExportColumn<never>[],
      filters: today(),
    }),
  },

  leave_balances: {
    subject: "leave_balances",
    title: "Leave balances",
    filename: "leave-balances",
    load: async (signal) => ({
      rows: await fetchLeaveBalances({}, SUBJECT_ROW_CAP, signal),
      columns: BALANCES_COLUMNS as readonly ExportColumn<never>[],
      filters: today(),
    }),
  },

  leave_taken: {
    subject: "leave_taken",
    title: "Leave taken",
    filename: "leave-taken",
    load: async (signal) => {
      /* DECIDED leave only. A pending request is not leave taken, and a file
         mixing the two would be read as a consumption figure it is not. */
      const page = await fetchLeaveRequests(
        { statuses: ["approved"] },
        SUBJECT_ROW_CAP,
        null,
        signal,
      );
      return {
        rows: page.rows,
        columns: LEAVE_TAKEN_COLUMNS as readonly ExportColumn<never>[],
        filters: today(),
      };
    },
  },

  headcount: {
    subject: "headcount",
    title: "Headcount by department",
    filename: "headcount",
    load: async (signal) => ({
      /* The current IST year. `istToday()` is the sanctioned clock — a browser
         `new Date().getFullYear()` would roll over at the wrong midnight. */
      rows: await fetchHeadcountMonthly(Number(istToday().slice(0, 4)), null, signal),
      columns: HEADCOUNT_COLUMNS as readonly ExportColumn<never>[],
      filters: today(),
    }),
  },

  approvals_pending: {
    subject: "approvals_pending",
    title: "Approvals waiting",
    filename: "approvals-waiting",
    load: async (signal) => {
      const page = await fetchApprovalRequests(
        { slice: "open" },
        SUBJECT_ROW_CAP,
        null,
        signal,
      );
      return {
        rows: page.rows,
        columns: APPROVALS_COLUMNS as readonly ExportColumn<never>[],
        filters: today(),
      };
    },
  },
};

/**
 * Why a subject has no download, in the words the screen shows.
 *
 * Two distinct reasons, and conflating them would be the mistake: one is a
 * governance line that a browser must not cross, the other is simply not built.
 */
export function whyNotRenderable(subject: ReportSubject): "pii" | "unbuilt" | null {
  if (subject in RENDERABLE_SUBJECTS) return null;
  return subject === "payroll_register" || subject === "payroll_statutory"
    ? "pii"
    : "unbuilt";
}
