/**
 * leaveBalanceGrid.ts — one row per employee, one column per leave type.
 *
 * WHY THE GRID CHANGED SHAPE
 * --------------------------
 * `v_leave_balance_current` returns one row per employee PER TYPE, and the screen
 * rendered it that way: 14 Management staff became 28 rows, with a "Leave type"
 * cell and a filter to narrow it. The venue reads this against a spreadsheet whose
 * shape is one line per person — Name | Earned Leave | Sick Leave | Weekly Offs —
 * and asked for the type to be the COLUMN NAME rather than a value in a cell.
 *
 * So the type dimension moves from rows to columns. 28 rows become 14, the leave
 * type filter stops being needed (every type is visible at once), and the grid
 * lines up with the document it is checked against.
 *
 * WHAT THIS COSTS, STATED PLAINLY
 * -------------------------------
 * Opening, Accrued this month, Lapsed, Spendable and Nearest expiry are all
 * per-type figures. In a pivot they would need one column each PER TYPE — five
 * types × six figures is thirty columns nobody can read. They are gone from this
 * view; the per-type detail lives one click away in the balance ledger, which is
 * where the credits and debits behind a number belong anyway.
 *
 * A TYPE WITH NO BALANCE ROW READS ZERO IN BOTH COLUMNS, NOT BLANK. Maternity, paternity and
 * week-off are granted per case at this venue, so most people have no row for
 * them. Zero is the truth — nothing has been granted — and it is a number the
 * reader can act on. An empty cell would be indistinguishable from a failed read.
 */
import type { LeaveBalance, LeaveType } from "../api/leave.api";

/**
 * What one leave type holds for one employee.
 *
 * TWO NUMBERS, NOT ONE. A balance alone answers "can they take leave"; it does not
 * answer "have they taken any", and those are different questions asked of the same
 * screen. `used` is `availed_days` — leave actually taken and approved, not days
 * sitting in a pending request.
 */
export interface TypeCell {
  readonly available: number;
  readonly used: number;
}

/** One employee, with available and used for every offered leave type. */
export interface PivotedBalance {
  readonly employeeId: string;
  /** The leave year every figure in this row belongs to. */
  readonly leaveYear: number;
  /** Per leave type id. Every offered type is present, zeroed if there is no row. */
  readonly byTypeId: ReadonlyMap<string, TypeCell>;
  /** Latest recompute across this employee's rows, or null if never. */
  readonly lastRecomputedAt: string | null;
}

/**
 * The leave types that become columns: offered only, in the venue's own order.
 *
 * Retired types are excluded even when somebody still holds days against one. A
 * column for Bereavement that is zero for all 83 people is furniture, and the days
 * still owed are visible in that employee's ledger. `sort_order` is what the leave
 * master screen uses, so the columns appear in the order HR arranged them rather
 * than alphabetically.
 */
export function columnTypes(types: readonly LeaveType[]): readonly LeaveType[] {
  return [...types]
    .filter((type) => type.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
}

/**
 * Collapse per-type rows into one row per employee.
 *
 * `columns` decides which types get a cell, so an employee holding days in a
 * retired type contributes nothing for it — the row shape stays identical across
 * every employee, which is what lets the grid render fixed columns at all.
 */
export function pivotBalances(
  rows: readonly LeaveBalance[],
  columns: readonly LeaveType[],
): readonly PivotedBalance[] {
  const byEmployee = new Map<
    string,
    { year: number; cells: Map<string, TypeCell>; recomputed: string | null }
  >();

  for (const row of rows) {
    let entry = byEmployee.get(row.employee_id);
    if (entry === undefined) {
      entry = { year: row.leave_year, cells: new Map<string, TypeCell>(), recomputed: null };
      byEmployee.set(row.employee_id, entry);
    }
    entry.cells.set(row.leave_type_id, {
      available: row.available_days,
      used: row.availed_days,
    });
    /*
      The most recent recompute across the employee's rows. Each type is recomputed
      independently, so taking the first would report a stale time whenever one
      type had not moved in a while.
    */
    if (
      row.last_recomputed_at !== null &&
      (entry.recomputed === null || row.last_recomputed_at > entry.recomputed)
    ) {
      entry.recomputed = row.last_recomputed_at;
    }
  }

  const out: PivotedBalance[] = [];
  for (const [employeeId, entry] of byEmployee) {
    const byTypeId = new Map<string, TypeCell>();
    for (const type of columns) {
      byTypeId.set(type.id, entry.cells.get(type.id) ?? { available: 0, used: 0 });
    }
    out.push({
      employeeId,
      leaveYear: entry.year,
      byTypeId,
      lastRecomputedAt: entry.recomputed,
    });
  }
  return out;
}
