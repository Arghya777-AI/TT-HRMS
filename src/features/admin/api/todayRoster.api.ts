/**
 * todayRoster.api.ts — today, one row per person, grouped management first.
 *
 * ── WHY THIS LAYERS RATHER THAN QUERIES ──────────────────────────────────────
 * `fetchTodayBoard` already reads `v_attendance_today_board`, which the analytics tiles and
 * the live board both use. Adding a second read of the same view would give the dashboard its
 * own copy of the truth — and the first time the two disagreed, nobody would know which screen
 * to believe. So the roster is a projection of the same rows.
 *
 * Two things the view cannot supply are fetched alongside it:
 *
 *   THE MANAGEMENT FLAG. `designations.is_managerial` / `is_executive`. The board view joins
 *   departments, not designations, and adding a column to a shared view needs a migration —
 *   which this environment cannot apply. So it is joined here, in memory, over ~80 rows.
 *
 *   THE EXPECTED MINUTES. `shifts.duration_minutes`, which is already NET of the unpaid break
 *   (General is 480 against a 09:30–18:30 window), so it is used as-is. Verified against the
 *   employee register, which shows exactly 8h expected for that shift — the two screens must
 *   agree or one of them is lying about the same day.
 *
 * ── WHAT IS NEVER RECOMPUTED ─────────────────────────────────────────────────
 * Worked minutes, lateness and status all come from the engine's own columns. Only the
 * VARIANCE is arithmetic here, and only because no view carries it: worked minus expected.
 * Recomputing lateness from the punch times would disagree with payroll the moment a policy
 * overrode a shift's grace, which this repo has already been bitten by once.
 */
import { z } from "zod";
import { selectMany } from "@/shared/api/query";
import { fetchTodayBoard } from "./analytics.api";
import type { TodayBoardRow } from "./attendance.api";

/** Which block of the roster somebody belongs in. */
export type StaffGroup = "management" | "staff";

/** How the day's attendance reached the system. */
export type CaptureMethod = "gate" | "web" | "mixed" | "none";

export interface RosterRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly departmentName: string | null;
  readonly designationName: string | null;
  readonly group: StaffGroup;
  /** The engine's status, verbatim. */
  readonly status: string | null;
  /** True when they have actually scanned today. */
  readonly attended: boolean;
  /** On a weekly off, a holiday, or approved leave — neither present nor absent. */
  readonly offToday: boolean;
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

export interface TodayRoster {
  readonly management: readonly RosterRow[];
  readonly staff: readonly RosterRow[];
  readonly counts: {
    readonly present: number;
    readonly absent: number;
    readonly onLeave: number;
    readonly onRoll: number;
  };
  /** True when the underlying board read hit its row cap. */
  readonly truncated: boolean;
}

/** `employees` with just enough of its designation to group by. */
const employeeGroupSchema = z.object({
  id: z.string().uuid(),
  designations: z
    .object({
      name: z.string().nullable(),
      is_managerial: z.boolean().nullable(),
      is_executive: z.boolean().nullable(),
    })
    .nullable(),
});

const shiftDurationSchema = z.object({
  id: z.string().uuid(),
  duration_minutes: z.number().int().nullable(),
});

/**
 * The statuses that mean "away today, and that is fine".
 *
 * Taken from the board view's own `off_today` list so the two cannot drift. Leave is separated
 * out because the client asked for it as its own number — an absence and a booked leave day
 * look identical on a roster otherwise, and only one of them is a problem.
 */
const LEAVE_STATUSES = new Set(["on_leave", "on_leave_half", "comp_off_availed"]);

function methodFor(row: TodayBoardRow): CaptureMethod {
  if (row.punch_count === 0) return "none";
  if (row.web_punch_count === 0) return "gate";
  return row.web_punch_count >= row.punch_count ? "web" : "mixed";
}

export async function fetchTodayRoster(
  opts: { readonly signal?: AbortSignal } = {},
): Promise<TodayRoster> {
  const signal = opts.signal;

  /*
    Three reads in parallel. The board is the one that matters; the other two are small
    reference sets that would otherwise serialise behind it for no reason.
  */
  const [board, groups, shifts] = await Promise.all([
    fetchTodayBoard(signal ? { signal } : {}),
    selectMany("employees", employeeGroupSchema, {
      columns: "id, designations(name, is_managerial, is_executive)",
      ...(signal ? { signal } : {}),
    }),
    selectMany("shifts", shiftDurationSchema, {
      columns: "id, duration_minutes",
      ...(signal ? { signal } : {}),
    }),
  ]);

  const byEmployee = new Map(groups.map((g) => [g.id, g]));
  const durationByShift = new Map(shifts.map((s) => [s.id, s.duration_minutes ?? 0]));

  const rows: RosterRow[] = board.rows.map((row) => {
    const meta = byEmployee.get(row.employee_id);
    const designation = meta?.designations ?? null;
    const isManagement =
      designation?.is_managerial === true || designation?.is_executive === true;

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
      departmentName: row.department_name,
      designationName: designation?.name ?? null,
      group: isManagement ? "management" : "staff",
      status: row.status,
      attended: row.attended,
      offToday: row.off_today,
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

  const onLeave = rows.filter((r) => r.status !== null && LEAVE_STATUSES.has(r.status)).length;
  const present = rows.filter((r) => r.attended).length;
  /*
    Absent is what is LEFT — not a status of its own. Someone is absent when the day expected
    them, they have not scanned, and they are not off. Counting a status called "absent" would
    miss everybody the engine has not processed yet, which on this data is most of the month.
  */
  const absent = rows.filter((r) => !r.attended && !r.offToday).length;

  return {
    management: rows.filter((r) => r.group === "management"),
    staff: rows.filter((r) => r.group === "staff"),
    counts: { present, absent, onLeave, onRoll: rows.length },
    truncated: board.provenance.truncated,
  };
}
