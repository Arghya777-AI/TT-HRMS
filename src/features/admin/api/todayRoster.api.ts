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
import { eq, selectMany } from "@/shared/api/query";
import { istToday } from "@/lib/datetime";
import { distanceFromVenue, type VenueDistance, type VenuePoint } from "@/lib/venueDistance";
import { t } from "@/shared/i18n/en";
import { fetchTodayBoard } from "./analytics.api";
import { V_PUNCH_DETAIL } from "./attendance.api";
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
  /**
   * The raw instants, for the live on-site clock.
   *
   * The `_hm` strings are pre-rendered IST wall clocks and cannot be subtracted; `elapsedOnSite`
   * needs real timestamps. Both come from the same view row, so there is no second source of
   * truth about when somebody arrived.
   */
  readonly firstInAt: string | null;
  readonly lastOutAt: string | null;
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
  /**
   * WHERE the day's punches were taken, and how far from the venue.
   *
   * Null when today's punches carry no coordinates. That is the normal state for the 27 gate
   * punches out of 908 whose tablet withheld a fix, and for every punch recorded before a
   * location became mandatory on the web route.
   */
  readonly fix: PunchFixOnRoster | null;
}

/** One punch's position, plus what it means relative to the venue. */
export interface PunchFixOnRoster {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMetres: number | null;
  /** `gate` or `web`, so a distance can be read in the light of who was watching. */
  readonly via: "gate" | "web";
  /** Null when nobody has told this system where the venue is. */
  readonly distance: VenueDistance | null;
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
  /**
   * The venue's reference point, or null when `locations.lat/lng` are unset.
   *
   * Surfaced rather than swallowed: with no venue point there are no distances anywhere on this
   * screen, and an admin needs to know that is a missing setting rather than everybody
   * happening to punch from the gate.
   */
  readonly venue: VenuePoint | null;
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

/**
 * Today's punches, coordinates only.
 *
 * `v_attendance_today_board` carries no position, so the fixes come from
 * `v_attendance_punch_detail` — the same view the punch log renders, filtered to the IST date
 * the board is already about. Read as its own query rather than joined into the board, because
 * the board is a shared view four screens depend on and widening it needs a migration this
 * environment cannot apply.
 */
const punchFixSchema = z.object({
  employee_id: z.string().uuid(),
  punched_at: z.string(),
  source: z.string(),
  lat: z.union([z.number(), z.string()]).nullable(),
  lng: z.union([z.number(), z.string()]).nullable(),
  location_accuracy_m: z.union([z.number(), z.string()]).nullable(),
});

/** The venue. One row — the primary location. */
const venueSchema = z.object({
  name: z.string(),
  lat: z.union([z.number(), z.string()]).nullable(),
  lng: z.union([z.number(), z.string()]).nullable(),
  geofence_radius_m: z.number().int().nullable(),
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

/**
 * A Postgres `numeric` as a number.
 *
 * PostgREST serialises `numeric` as a STRING, to keep the precision JSON floats would lose.
 * `lat`, `lng` and `location_accuracy_m` are all numeric, so every one of them arrives as
 * "12.864249" — and `Number(undefined)` is NaN while `Number(null)` is 0, which is a coordinate
 * on the Gulf of Guinea. Hence the explicit null path.
 */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

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
  const today = istToday();
  const [board, designations, shifts, fixes, venues] = await Promise.all([
    fetchTodayBoard(signal ? { signal } : {}),
    selectMany("employees", employeeDesignationSchema, {
      columns: "id, designations(name)",
      ...(signal ? { signal } : {}),
    }),
    selectMany("shifts", shiftDurationSchema, {
      columns: "id, duration_minutes",
      ...(signal ? { signal } : {}),
    }),
    selectMany(V_PUNCH_DETAIL, punchFixSchema, {
      columns: "employee_id, punched_at, source, lat, lng, location_accuracy_m",
      filters: [eq("ist_date", today)],
      // Oldest first, so the reduce below can prefer a later punch by simply overwriting.
      order: [{ column: "punched_at", ascending: true }],
      ...(signal ? { signal } : {}),
    }),
    selectMany("locations", venueSchema, {
      columns: "name, lat, lng, geofence_radius_m",
      filters: [eq("is_primary", true)],
      limit: 1,
      ...(signal ? { signal } : {}),
    }),
  ]);

  /*
    The venue point. BOTH halves or nothing — a latitude with no longitude is not half a
    position, it is no position, and treating it as one would put a distance from the equator on
    screen. `geofence_radius_m` is NOT NULL DEFAULT 300 on the table; the fallback covers only a
    row that could not be read.
  */
  const venueRow = venues[0];
  const venueLat = num(venueRow?.lat);
  const venueLng = num(venueRow?.lng);
  const venue: VenuePoint | null =
    venueRow === undefined || venueLat === null || venueLng === null
      ? null
      : {
        lat: venueLat,
        lng: venueLng,
        radiusM: venueRow.geofence_radius_m ?? 300,
        name: venueRow.name,
      };

  /*
    One fix per employee, and WEB WINS over the gate.

    Not "the latest punch": a person who punches from home in the morning and at the gate in the
    afternoon would show 0 m, and the 4 km reading — the one an admin actually needs to see — is
    the one that disappears. A gate punch's position is barely information, since the tablet is
    bolted to a known wall; a web punch's position is the entire reason this column exists.
  */
  const fixByEmployee = new Map<string, PunchFixOnRoster>();
  for (const row of fixes) {
    const lat = num(row.lat);
    const lng = num(row.lng);
    if (lat === null || lng === null) continue;
    const via = row.source === "web" || row.source === "mobile" ? "web" : "gate";
    const existing = fixByEmployee.get(row.employee_id);
    if (existing !== undefined && existing.via === "web" && via === "gate") continue;
    const accuracyMetres = num(row.location_accuracy_m);
    fixByEmployee.set(row.employee_id, {
      latitude: lat,
      longitude: lng,
      accuracyMetres,
      via,
      distance: distanceFromVenue({ latitude: lat, longitude: lng, accuracyMetres }, venue),
    });
  }

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
      firstInAt: row.first_in_at,
      lastOutAt: row.last_out_at,
      method: methodFor(row),
      workedMinutes: row.worked_minutes,
      expectedMinutes: expected,
      varianceMinutes: expected > 0 ? row.worked_minutes - expected : null,
      lateMinutes: row.late_minutes,
      punchCount: row.punch_count,
      fix: fixByEmployee.get(row.employee_id) ?? null,
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
    venue,
    counts: countRows(rows),
    truncated: board.provenance.truncated,
  };
}
