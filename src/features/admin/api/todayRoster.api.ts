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
import { fmtTime, istToday } from "@/lib/datetime";
import { attendedOn, offOn } from "../rosterDayStatus";
import { distanceFromVenue, type VenueDistance, type VenuePoint } from "@/lib/venueDistance";
import { t } from "@/shared/i18n/en";
import { fetchTodayBoard } from "./analytics.api";
import { V_DAY_ENRICHED, V_PUNCH_DETAIL } from "./attendance.api";

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
  /**
   * Whether the day is actually late, which is NOT `lateMinutes > 0`.
   *
   * The engine measures lateness from shift start and lets GRACE decide whether it counts —
   * `is_late = late_minutes > grace_in_minutes` — so a scan at 09:31 against a 09:30 shift
   * with ten minutes of grace stores one minute and is not late. The roster was rendering the
   * minutes and ignoring the verdict, so it announced "+0h 01m late" for somebody who was on
   * time by the venue's own rule.
   */
  readonly isLate: boolean;
  readonly punchCount: number;
  /**
   * The shift these punches are read against, or null where no shift is assigned.
   *
   * Null is honest and the punch column falls back to consecutive pairing on it: without the
   * window there is no way to know which scan closed the working session, and guessing 09:30
   * for somebody on nights would put their whole evening under "extra".
   */
  readonly shiftWindow: { readonly startTime: string; readonly endTime: string } | null;
  /**
   * WHERE the day's punches were taken, and how far from the venue.
   *
   * Null when today's punches carry no coordinates. That is the normal state for the 27 gate
   * punches out of 908 whose tablet withheld a fix, and for every punch recorded before a
   * location became mandatory on the web route.
   */
  /**
   * Every punch today, in order, each with where it was taken.
   *
   * Was ONE fix per person, web preferred over gate. That answered "was this person away" and
   * could not answer "away WHEN" — a day of 09:00 at the gate then 19:00 from home showed only
   * the 19:00, so the gate arrival vanished. The industry convention for an attendance row is a
   * punch timeline, so the list is kept whole and the column renders it.
   */
  readonly punches: readonly PunchOnRoster[];
  /**
   * How many of the day's punches are still waiting on an administrator.
   *
   * Not minutes: the day's pending MINUTES are the engine's figure and cannot be attributed to
   * a single punch, so the roster reports the count and the star, and the person's own
   * attendance page carries the number.
   */
  readonly awaitingApproval: number;
}

/** One punch's position, plus what it means relative to the venue. */
/** One punch: when, how, where, and how far from the venue. */
export interface PunchOnRoster {
  /** IST wall clock, `HH:MM`, pre-formatted so the cell does no timezone arithmetic. */
  readonly at: string;
  /** `gate` or `web`, so a distance can be read in the light of who was watching. */
  readonly via: "gate" | "web";
  /** Null when the punch carried no coordinates — every gate punch before the tablet shared one. */
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyMetres: number | null;
  /** Null with no coordinates, or when nobody has told this system where the venue is. */
  readonly distance: VenueDistance | null;
  /**
   * True when this punch is outside the shift window and no administrator has decided it yet.
   *
   * The hours ARE in the day's worked figure — that is the venue's rule — and they are held
   * out of the monthly total until somebody accepts the reason. The star on the row is what
   * tells a reader the two figures differ on purpose.
   */
  readonly awaitingApproval: boolean;
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
  /*
    Needed because `v_attendance_day_enriched` publishes `department_name` but not
    `department_id`, and the roster groups on the ID — two departments can share a display name
    after a rename, and a group keyed on the name would silently merge them.

    It is the employee's CURRENT department, so somebody who transferred appears under where
    they are now rather than where they were on the day. That is the reading an admin scanning
    "who was in on Tuesday" expects, and it keeps the key and the heading from disagreeing.
  */
  department_id: z.string().uuid().nullable(),
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
  /*
    Whether an administrator still has to accept this punch. Read from the punch log rather
    than from the day, because the roster already loads every punch for the timeline — a
    second read of `attendance_days.pending_approval_minutes` would be a second source for
    the same fact.
  */
  requires_approval: z.boolean().nullable(),
  approved_at: z.string().nullable(),
});

/**
 * The same roster fields, for ANY date, out of `v_attendance_day_enriched`.
 *
 * `v_attendance_today_board` only knows today — it is literally scoped to `util.ist_today()` —
 * so looking at yesterday means a different view. This one has every field the roster needs
 * except two: `attended` and `off_today` are SQL columns on the board and are derived here by
 * `rosterDayStatus`, whose test pins the status lists against the board's own definition so the
 * two cannot drift; and `department_id`, which comes off the employee read instead.
 */
const dayRosterRowSchema = z.object({
  employee_id: z.string().uuid(),
  employee_code: z.string(),
  display_name: z.string(),
  department_name: z.string().nullable(),
  status: z.string().nullable(),
  punch_count: z.number().int(),
  first_in_hm: z.string().nullable(),
  last_out_hm: z.string().nullable(),
  first_in_at: z.string().nullable(),
  last_out_at: z.string().nullable(),
  total_worked_minutes: z.number().int(),
  late_minutes: z.number().int(),
  /** The engine's verdict AFTER grace, not a re-derivation of it. */
  is_late: z.boolean(),
  shift_id: z.string().uuid().nullable(),
});

/** The venue. One row — the primary location. */
const venueSchema = z.object({
  name: z.string(),
  lat: z.union([z.number(), z.string()]).nullable(),
  lng: z.union([z.number(), z.string()]).nullable(),
  geofence_radius_m: z.number().int().nullable(),
});

/*
 * The window as well as the paid length.
 *
 * `duration_minutes` alone was enough while the punch column paired scans in order. It is not
 * enough to say which scan ENDED the working session, which is what separates Meghana's midday
 * movement from Arghya's evening return — see punchSessions.ts.
 */
const shiftDurationSchema = z.object({
  id: z.string().uuid(),
  duration_minutes: z.number().int().nullable(),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
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

/*
  Narrowed to the two fields it reads. It took a whole `TodayBoardRow`, which shut out the
  per-day path — that view publishes neither `web_punch_count` nor two dozen other board
  columns, and demanding them for a function that looks at two is the same over-specification
  that kept `dayVariance` from being reused on the admin side.
*/
function methodFor(row: { punch_count: number; web_punch_count: number }): CaptureMethod {
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

/** The subset of a board row the roster actually uses, so both sources can produce it. */
interface NormalisedRow {
  readonly employee_id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly department_name: string | null;
  readonly status: string | null;
  readonly attended: boolean;
  readonly off_today: boolean;
  readonly punch_count: number;
  readonly web_punch_count: number;
  readonly first_in_hm: string | null;
  readonly last_out_hm: string | null;
  readonly first_in_at: string | null;
  readonly last_out_at: string | null;
  readonly worked_minutes: number;
  readonly late_minutes: number;
  readonly is_late: boolean;
  readonly shift_id: string | null;
}

export async function fetchTodayRoster(
  opts: { readonly signal?: AbortSignal; readonly date?: string } = {},
): Promise<TodayRoster> {
  const signal = opts.signal;

  /*
    ── TODAY IS A DIFFERENT READ FROM ANY OTHER DAY ──────────────────────────
    `v_attendance_today_board` is scoped to `util.ist_today()` inside the view, so it cannot
    answer for yesterday. It is still the right source for today: it publishes `attended` and
    `off_today` as SQL, and it carries the live flags — `yet_to_reach`, `overdue` — that only
    mean anything about a day in progress.

    Any other date reads `v_attendance_day_enriched` and derives those two booleans through
    `rosterDayStatus`, whose test pins its status lists against the board's own SQL so today's
    roster and yesterday's cannot disagree about the same person.
  */
  const today = istToday();
  const date = opts.date ?? today;
  const isToday = date === today;

  const [board, designations, shifts, fixes, venues] = await Promise.all([
    isToday
      ? fetchTodayBoard(signal ? { signal } : {})
      : selectMany(V_DAY_ENRICHED, dayRosterRowSchema, {
        columns:
          "employee_id, employee_code, display_name, department_name, status, punch_count, " +
          "first_in_hm, last_out_hm, first_in_at, last_out_at, total_worked_minutes, " +
          "late_minutes, is_late, shift_id",
        filters: [eq("ist_date", date)],
        // The venue is under a hundred people; a cap above that is a guard, not a page.
        limit: 500,
        ...(signal ? { signal } : {}),
      }).then((rows) => ({
        rows,
        provenance: { truncated: rows.length >= 500 },
      })),
    selectMany("employees", employeeDesignationSchema, {
      columns: "id, department_id, designations(name)",
      ...(signal ? { signal } : {}),
    }),
    selectMany("shifts", shiftDurationSchema, {
      columns: "id, duration_minutes, start_time, end_time",
      ...(signal ? { signal } : {}),
    }),
    selectMany(V_PUNCH_DETAIL, punchFixSchema, {
      columns:
        "employee_id, punched_at, source, lat, lng, location_accuracy_m, " +
        "requires_approval, approved_at",
      filters: [eq("ist_date", date)],
      // Oldest first, so the timeline below renders in the order the punches happened.
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
    EVERY punch, per employee, in the order they were taken.

    This used to keep one — web preferred over the gate — which answered "was this person away
    today" and could not answer "away when". A day of 09:00 at the gate and 19:00 from home
    showed only the 19:00 and lost the arrival entirely. A punch timeline is what an attendance
    row shows everywhere else in this industry, and it is what was asked for: the location of
    the in AND the out, in one column.

    The query already returns `punched_at` ascending, so pushing preserves that order.
  */
  const designationByEmployee = new Map(
    designations.map((d) => [d.id, d.designations?.name ?? null]),
  );
  const departmentByEmployee = new Map(designations.map((d) => [d.id, d.department_id]));
  const durationByShift = new Map(shifts.map((sh) => [sh.id, sh.duration_minutes ?? 0]));
  const windowByShift = new Map(
    shifts
      .filter((sh) => sh.start_time !== null && sh.end_time !== null)
      .map((sh) => [sh.id, { startTime: sh.start_time as string, endTime: sh.end_time as string }]),
  );

  const punchesByEmployee = new Map<string, PunchOnRoster[]>();
  for (const row of fixes) {
    const lat = num(row.lat);
    const lng = num(row.lng);
    const accuracyMetres = num(row.location_accuracy_m);
    const punch: PunchOnRoster = {
      at: fmtTime(row.punched_at),
      via: row.source === "web" || row.source === "mobile" ? "web" : "gate",
      latitude: lat,
      longitude: lng,
      accuracyMetres,
      distance:
        lat === null || lng === null
          ? null
          : distanceFromVenue({ latitude: lat, longitude: lng, accuracyMetres }, venue),
      awaitingApproval: row.requires_approval === true && row.approved_at === null,
    };
    const bucket = punchesByEmployee.get(row.employee_id);
    if (bucket === undefined) punchesByEmployee.set(row.employee_id, [punch]);
    else bucket.push(punch);
  }

  /*
    ── ONE SHAPE, WHICHEVER VIEW ANSWERED ────────────────────────────────────
    The board publishes `attended`, `off_today` and `web_punch_count`; the per-day view
    publishes none of them. Rather than branch through the mapping below — which would mean two
    copies of the variance arithmetic and the department grouping — both are normalised here.

    `attendedOn` / `offOn` are the shared definitions, pinned by test against the board's own
    SQL. `web_punch_count` is recovered from the punch timeline that has already been fetched,
    so the "Captured via" reading is the same fact on either path.
  */
  const webPunchesByEmployee = new Map<string, number>();
  for (const f of fixes) {
    if (f.source !== "web" && f.source !== "mobile") continue;
    webPunchesByEmployee.set(f.employee_id, (webPunchesByEmployee.get(f.employee_id) ?? 0) + 1);
  }

  const normalised: NormalisedRow[] = board.rows.map((row) =>
    "attended" in row
      ? {
        ...row,
        worked_minutes: row.worked_minutes,
      }
      : {
        employee_id: row.employee_id,
        employee_code: row.employee_code,
        display_name: row.display_name,
        department_name: row.department_name,
        status: row.status,
        attended: attendedOn({ status: row.status, punchCount: row.punch_count }),
        off_today: offOn({ status: row.status, punchCount: row.punch_count }),
        punch_count: row.punch_count,
        web_punch_count: webPunchesByEmployee.get(row.employee_id) ?? 0,
        first_in_hm: row.first_in_hm,
        last_out_hm: row.last_out_hm,
        first_in_at: row.first_in_at,
        last_out_at: row.last_out_at,
        worked_minutes: row.total_worked_minutes,
        late_minutes: row.late_minutes,
        is_late: row.is_late,
        shift_id: row.shift_id,
      },
  );

  const rows: RosterRow[] = normalised.map((row) => {
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
      /*
        From the employee read, not the row: the per-day view publishes `department_name` and
        not the id, and the roster groups on the id so a rename cannot merge two departments.
      */
      departmentId: departmentByEmployee.get(row.employee_id) ?? null,
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
      isLate: row.is_late,
      punchCount: row.punch_count,
      shiftWindow: windowByShift.get(row.shift_id ?? "") ?? null,
      punches: punchesByEmployee.get(row.employee_id) ?? [],
      awaitingApproval: (punchesByEmployee.get(row.employee_id) ?? [])
        .filter((punch) => punch.awaitingApproval).length,
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
