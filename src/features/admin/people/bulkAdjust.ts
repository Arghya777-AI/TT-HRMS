/**
 * bulkAdjust.ts — what "Adjust all" would actually write.
 *
 * WHY A SHEET AND NOT A SPREADSHEET
 * ---------------------------------
 * The first design for this was: download a workbook, fill it in, upload it. It was
 * dropped for a better reason than convenience — a downloaded file cannot show the
 * CURRENT balance next to the number being typed. Weekly-off is granted a day or
 * two at a time against what somebody already has, so "31 → 32" is the check that
 * matters, and it only exists if both numbers are on screen together. A round trip
 * through Excel also reintroduces every encoding problem the CSV importer has to
 * defend against, for a job that is usually a dozen small edits.
 *
 * WHAT IT IS MAINLY FOR
 * ---------------------
 * Week-off, and anything else granted by hand. Sick and earned leave accrue on a
 * schedule and are capped at the year end, so they rarely need touching in bulk —
 * which is why the type picker opens on the manual ones rather than on earned leave.
 *
 * THREE DIRECTIONS, AND "SET TO" IS NOT A CREDIT
 * ----------------------------------------------
 * `credit` and `debit` move a balance by an amount; `set` moves it TO an amount, so
 * the days posted are the difference and the sign depends on where the balance
 * already is. Folding "set" into "credit" is how a balance of 34 asked to become 30
 * ends up at 64.
 */

/** What the administrator chose to do to every row they filled in. */
export type AdjustDirection = "credit" | "debit" | "set";

/** One employee's line in the sheet: what they hold, and what was typed. */
export interface BulkRowInput {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  /** Their balance in the chosen type, right now. */
  readonly current: number;
  /** Exactly as typed. Blank means "leave this person alone". */
  readonly typed: string;
}

/** A write that would be posted, with the numbers a reader can check. */
export interface BulkChange {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly current: number;
  readonly target: number;
  /** Positive credits, negative debits. Never zero. */
  readonly delta: number;
}

export interface BulkProblem {
  readonly employeeCode: string;
  readonly message: string;
}

export interface BulkPlan {
  readonly changes: readonly BulkChange[];
  readonly problems: readonly BulkProblem[];
  /** Filled in, but already at that figure — nothing to write. */
  readonly noChange: number;
  /** Left blank, so deliberately untouched. */
  readonly skipped: number;
}

/**
 * Read a typed day count.
 *
 * Refuses rather than coerces, and treats blank as "skip" rather than zero — a row
 * nobody filled in must not be read as "set this person to nothing".
 */
function parseTyped(raw: string): { days: number } | { error: string } | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { error: `"${raw.trim()}" is not a number of days.` };
  const days = Number(cleaned);
  if (days < 0) return { error: "A negative figure — use Debit instead of a minus sign." };
  if (days * 2 !== Math.floor(days * 2)) return { error: "Leave is counted in half days." };
  return { days };
}

/**
 * Turn the filled-in rows into the changes that would be posted.
 *
 * Every problem is collected rather than thrown, so the sheet can show all of them
 * at once and the administrator fixes the lot in one pass.
 */
export function planBulkAdjust(
  rows: readonly BulkRowInput[],
  direction: AdjustDirection,
  maxBalance: number | null,
): BulkPlan {
  const changes: BulkChange[] = [];
  const problems: BulkProblem[] = [];
  let noChange = 0;
  let skipped = 0;

  for (const row of rows) {
    const read = parseTyped(row.typed);
    if (read === null) {
      skipped += 1;
      continue;
    }
    if ("error" in read) {
      problems.push({ employeeCode: row.employeeCode, message: read.error });
      continue;
    }

    const target =
      direction === "set"
        ? read.days
        : direction === "credit"
          ? row.current + read.days
          : row.current - read.days;

    if (target < 0) {
      problems.push({
        employeeCode: row.employeeCode,
        message: `That would take them to ${String(target)} days. A balance cannot go below zero here.`,
      });
      continue;
    }

    /*
      The type's own ceiling, if it has one. Earned leave has none during the year
      (the 30-day limit binds at the year end), but a type that does would otherwise
      accept a figure the accrual immediately lapses — offering a number that will
      not survive the night.
    */
    if (maxBalance !== null && target > maxBalance) {
      problems.push({
        employeeCode: row.employeeCode,
        message: `That would take them to ${String(target)}, above this type's ceiling of ${String(maxBalance)} days.`,
      });
      continue;
    }

    const delta = target - row.current;
    if (delta === 0) {
      noChange += 1;
      continue;
    }

    changes.push({
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      current: row.current,
      target,
      delta,
    });
  }

  return { changes, problems, noChange, skipped };
}

/**
 * The leave types the picker should open on.
 *
 * Manual types first — week-off, maternity, paternity — because those are what gets
 * granted by hand. Sick and earned accrue on a schedule, so a bulk edit of them is
 * the unusual case and should take one extra click rather than be the default.
 */
export function preferredTypeOrder(
  types: readonly { readonly id: string; readonly code: string; readonly name: string }[],
): readonly { readonly id: string; readonly code: string; readonly name: string }[] {
  const manualFirst = new Set(["MRL", "ML", "PL"]);
  return [...types].sort((a, b) => {
    const aManual = manualFirst.has(a.code) ? 0 : 1;
    const bManual = manualFirst.has(b.code) ? 0 : 1;
    return aManual - bManual || a.name.localeCompare(b.name);
  });
}
