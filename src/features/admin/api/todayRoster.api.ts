/**
 * todayRoster.api.ts — today, one row per person, grouped BY DEPARTMENT.
 *
 * ── THE CORRECTION THAT DEFINES THIS FILE ────────────────────────────────────
 * The first version grouped on `designations.is_managerial / is_executive`, reading "management
 * first" as "the managers first". That was wrong, and the live data says so plainly: of the 20
 * people in the Management DEPARTMENT only 2 carry `is_managerial`, while Johar Lal Ree — Ground
 * department — does. The dashboard put him under "Management" and left thirteen actual Management
 * staff out of it.
 *
 * "Management" is a department here, alongside Ground, Restaurant and Coorg. So the grouping is
 * `employees.department_id`, which is a fact somebody maintains, rather than two designation
 * flags that were only ever set on a handful of rows.
 *
 * ── THE GROUPS ARE NOT A FIXED LIST ──────────────────────────────────────────
 * One group per department that has somebody on roll today, built from the data. Four are
 * populated at the moment (Ground 44, Management 20, Restaurant 16, Coorg 2) out of 21 that
 * exist. Hardcoding today's four would mean a new department — a first floor, say — silently
 * not appearing, and the seventeen empty ones would render as seventeen empty tables.
 *
 * Management leads because it was asked for. After that, headcount descending: the department
 * somebody scans first is the big one, and the populated departments all share `sort_order` 100
 * so the org's own ordering cannot break the tie. Name breaks it instead, so the order is
 * stable rather than dependent on row arrival.
 *
 * ── EVERY GROUP CARRIES ITS OWN NUMBERS ──────────────────────────────────────
 * Present, absent and on-leave per department, not just for the venue. A single pair of totals
 * cannot answer "is Restaurant short today", which is the question a venue actually acts on.
 *
 * ── WHAT IS NEVER RECOMPUTED ─────────────────────────────────────────────────
 * Worked minutes, lateness and status all come from the engine's own columns. Only the VARIANCE
 * is arithmetic here, and only because no view carries it: worked minus expected. Recomputing
 * lateness from the punch times would disagree with payroll the moment a policy overrode a
 * shift's grace, which this repo has already been bitten by once.
 */
import { z } from "zod";
import { selectMany } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import { fetchTodayBoard } from "./analytics.api";
import type { TodayBoardRow } from "./attendance.api";

/** How the day's attendance reached the system. */
export type CaptureMethod = "gate" | "web" | "mixed" | "none";

export interface RosterRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  /** Shown in the row now that the department is the group heading. */
  readonly designationName: string | null;
  /** The engine's status, verbatim. */
  readonly status: string | null;
  /** True when they have actually scanned today. */
  readonly attended: boolean;
  /** On a weekly off, a holiday, or approved leave — neither present nor absent. */
  readonly offToday: boolean;
  readonly onLeave: boolean;
  readonly firstInHm: string | null;
  readonly lastOutHm: string | null;
  readonly method: CaptureMethod;
  readonly workedMinutes: number;
  readonly expectedMinutes: number;
  /**
   * Worked minus expected, or null when the day expects nothing.
   *
   * Null rather than zero on an off day: a weekly off is not somebody working exactly their
   * shift, and a green "0m" against it would read as though it were.
   */
  readonly varianceMinutes: number | null;
  readonly lateMinutes: number;
  readonly punchCount: number;
}

/** The same four figures, whether for one department or the whole venue. */
export interface RosterCounts {
  readonly present: number;
  readonly absent: number;
  readonly onLeave: number;
  readonly onRoll: number;
}

export interface RosterGroup {
  /** Department id, or "" for the people who have none. Also the React key. */
  readonly key: string;
  readonly name: string;
  readonly counts: RosterCounts;
  readonly rows: readonly RosterRow[];
}

export interface TodayRoster {
  readonly groups: readonly RosterGroup[];
  /** The venue total. Deliberately the sum of the groups, never a separate query. */
  readonly counts: RosterCounts;
  /** True when the underlying board read hit its row cap. */
  readonly truncated: boolean;
}

/**
 * `employees` with its designation name.
 *
 * `v_attendance_today_board` carries `department_id` and `department_name` but no designation,
 * and this read used to exist to fetch `is_managerial` / `is_executive` for the old grouping.
 * The grouping no longer needs them; the NAME is worth the same query, because with the
 * department promoted to the group heading the row had spare space and "Sales Manager" says
 * more about somebody than repeating their department would.
 */
const employeeDesignationSchema = z.object({
  id: z.string().uuid(),
  designations: z.object({ name: z.string().nullable() }).nullable(),
});

const shiftDurationSchema = z.object({
  id: z.string().uuid(),
  duration_minutes: z.number().int().nullable(),
});

/**
 * The statuses that mean "away today, and that is fine".
 *
 * Leave is separated from absence because they are different facts and only one of them is a
 * problem. Taken from the board view's own `off_today` list so the two cannot drift.
 */
const LEAVE_STATUSES = new Set(["on_leave", "on_leave_half", "comp_off_availed"]);

/** Pinned first, by name, because it is the group the venue's owner reads first. */
const LEAD_DEPARTMENT = "Management";

function methodFor(row: TodayBoardRow): CaptureMethod {
  if (row.punch_count === 0) return "none";
  if (row.web_punch_count === 0) return "gate";
  return row.web_punch_count >= row.punch_count ? "web" : "mixed";
}

function countRows(rows: readonly RosterRow[]): RosterCounts {
  return {
    present: rows.filter((r) => r.attended).length,
    onLeave: rows.filter((r) => r.onLeave).length,
    /*
      Absent is what is LEFT — not a status of its own. Someone is absent when the day expected
      them, they have not scanned, and they are not off. Counting a status called "absent" would
      miss everybody the engine has not processed yet, which on this data is most of the month.
    */
    absent: rows.filter((r) => !r.attended && !r.offToday).length,
    onRoll: rows.length,
  };
}

export async function fetchTodayRoster(
  opts: { readonly signal?: AbortSignal } = {},
): Promise<TodayRoster> {
  const signal = opts.signal;

  /*
    Three reads in parallel. The board is the one that matters; the other two are small
    reference sets that would otherwise serialise behind it for no reason.
  */
  const [board, designations, shifts] = await Promise.all([
    fetchTodayBoard(signal ? { signal } : {}),
    selectMany("employees", employeeDesignationSchema, {
      columns: "id, designations(name)",
      ...(signal ? { signal } : {}),
    }),
    selectMany("shifts", shiftDurationSchema, {
      columns: "id, duration_minutes",
      ...(signal ? { signal } : {}),
    }),
  ]);

  const designationByEmployee = new Map(designations.map((d) => [d.id, d.designations?.name ?? null]));
  const durationByShift = new Map(shifts.map((s) => [s.id, s.duration_minutes ?? 0]));

  const rows: RosterRow[] = board.rows.map((row) => {
    /*
      An off day expects nothing. Using the shift's duration there would report somebody on
      approved leave as eight hours short, which is the single most misleading thing this table
      could say about them.
    */
    const expected = row.off_today ? 0 : (durationByShift.get(row.shift_id ?? "") ?? 0);

    return {
      employeeId: row.employee_id,
      employeeCode: row.employee_code,
      displayName: row.display_name,
      departmentId: row.department_id,
      departmentName: row.department_name,
      designationName: designationByEmployee.get(row.employee_id) ?? null,
      status: row.status,
      attended: row.attended,
      offToday: row.off_today,
      onLeave: row.status !== null && LEAVE_STATUSES.has(row.status),
      firstInHm: row.first_in_hm,
      lastOutHm: row.last_out_hm,
      method: methodFor(row),
      workedMinutes: row.worked_minutes,
      expectedMinutes: expected,
      varianceMinutes: expected > 0 ? row.worked_minutes - expected : null,
      lateMinutes: row.late_minutes,
      punchCount: row.punch_count,
    };
  });

  /*
    Grouped from the rows themselves, so a department appears the moment somebody is in it and
    an empty one never renders. Keyed on the id rather than the name: two departments may share
    a display name after a rename, and the id is what the row actually carries.
  */
  const byDepartment = new Map<string, RosterRow[]>();
  for (const row of rows) {
    const key = row.departmentId ?? "";
    const bucket = byDepartment.get(key);
    if (bucket === undefined) byDepartment.set(key, [row]);
    else bucket.push(row);
  }

  const groups: RosterGroup[] = [...byDepartment.entries()].map(([key, groupRows]) => ({
    key,
    // The name off the rows, not a second lookup — the board view already joined it.
    name: groupRows[0]?.departmentName ?? t("admin.roster.group.none"),
    counts: countRows(groupRows),
    rows: groupRows,
  }));

  groups.sort((a, b) => {
    // Management first, then the biggest departments, then by name so the order never wobbles.
    const lead = (g: RosterGroup) => (g.name === LEAD_DEPARTMENT ? 0 : 1);
    // People with no department last of all: it is a gap in the record, not a team.
    const placed = (g: RosterGroup) => (g.key === "" ? 1 : 0);
    return (
      placed(a) - placed(b) ||
      lead(a) - lead(b) ||
      b.counts.onRoll - a.counts.onRoll ||
      a.name.localeCompare(b.name)
    );
  });

  return {
    groups,
    counts: countRows(rows),
    truncated: board.provenance.truncated,
  };
}
