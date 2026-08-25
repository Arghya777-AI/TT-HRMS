/**
 * What the gate's "last few scans" tail is allowed to show.
 *
 * THE TAIL LISTS PUNCHES, NOT SCAN ATTEMPTS. That distinction is the whole of this file, and
 * getting it wrong is what put the same person on two rows at the very same second.
 *
 * A suppressed re-scan — inside the debounce, or too soon after the check-in to count as a
 * check-out — writes no punch at all. `kiosk-punch` then answers it from the ORIGINAL punch, so
 * the person at the gate is told the time they really checked in rather than the time they
 * re-scanned. That is right for the card. It was wrong for the tail: appending the answer added
 * a second row carrying the FIRST row's timestamp, so a guard glancing down saw
 *
 *     Vinod Maurya   IN   12:33:59
 *     Vinod Maurya   IN   12:33:59
 *
 * and read it as a double entry. Nothing was double-recorded — the list was reprinting one
 * punch twice. The attendance record held one punch throughout.
 *
 * Kept out of the screen component so it can be tested for what it is: a small decision with
 * two distinct reasons to say no, both of which have already been got wrong once.
 */

/** One accepted scan — mirrors `RecentScan` in `../components/GateResult`. */
export interface RecentScanEntry {
  id: string;
  displayName: string;
  employeeCode: string;
  punchKind: string;
  istTime: string;
}

/** The fields of a `kiosk-punch` answer this decision reads. */
export interface ScanAnswer {
  matched?: boolean;
  duplicateSuppressed?: boolean;
  displayName?: string | null;
  employeeCode?: string | null;
  punchKind?: string | null;
  istTime?: string | null;
}

/**
 * The tail after this answer lands. Returns `prev` UNCHANGED — the same reference, so React
 * re-renders nothing — when the answer does not describe a new punch.
 *
 * Two separate reasons to add no row:
 *
 *   1. `duplicateSuppressed` — the server recorded nothing, so there is no punch to list. The
 *      card and the duplicate chime are what answer that person.
 *   2. Same employee, same instant, already listed — two captures in flight when the first
 *      response lands are both genuine, unsuppressed answers ABOUT THE SAME PUNCH. One punch
 *      is one row. Guarded on a non-empty code so unidentified rows cannot collapse into
 *      each other.
 *
 * `newId` is passed in rather than generated here so a test can assert the row's identity, and
 * so this stays a pure function.
 */
export function appendRecentScan(
  prev: readonly RecentScanEntry[],
  answer: ScanAnswer,
  newId: string,
  limit: number,
): readonly RecentScanEntry[] {
  if (answer.matched !== true) return prev;
  if (answer.duplicateSuppressed === true) return prev;

  const employeeCode = answer.employeeCode ?? "";
  const istTime = answer.istTime ?? "";
  const alreadyListed =
    employeeCode !== "" &&
    prev.some((scan) => scan.employeeCode === employeeCode && scan.istTime === istTime);
  if (alreadyListed) return prev;

  return [
    {
      id: newId,
      displayName: answer.displayName ?? "",
      employeeCode,
      punchKind: answer.punchKind ?? "scan",
      istTime,
    },
    ...prev,
  ].slice(0, limit);
}
