/**
 * The Punch Log's URL contract, and the aliases that arrive at it.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * "All scans for this person" on an employee's attendance page sends
 * `?employee=<uuid>`. The Punch Log read `?emp=`. Written separately, never matched, so
 * the button opened the log for EVERY employee — the one thing its label promises it
 * will not do. Three other links send `?date=` meaning "the scans on this day", which
 * was read as nothing, so a day-scoped link landed on the default 30-day range. The
 * Command Palette sends `review=true` against a test for `"1"`.
 *
 * None of these broke in a rename. They never worked once.
 *
 * The alternative — teaching the reader every spelling — is worse, and the reason is
 * the dropdown: it writes `emp`. Arriving on `?employee=X` and then changing the
 * dropdown leaves BOTH keys in the URL, and clearing the dropdown would then resurrect
 * X rather than clearing the filter. So an alias is rewritten once, on arrival, and the
 * URL only ever carries canonical keys afterwards.
 */

/** A URL flag is on in either spelling. `review=true` and `review=1` mean the same thing. */
export function isOn(value: string | null): boolean {
  return value === "1" || value === "true";
}

/**
 * The canonical form of an incoming query string, or `null` when it is already canonical.
 *
 * Returning `null` for "nothing to do" is what keeps the caller's effect from looping:
 * it only writes back when something actually changed.
 */
export function canonicalPunchLogParams(params: URLSearchParams): URLSearchParams | null {
  const next = new URLSearchParams(params);
  let touched = false;

  /*
    `employee` -> `emp`. An existing `emp` wins: it came from the dropdown, which is a
    later and more deliberate act than the link that opened the page.
  */
  const alias = next.get("employee");
  if (alias !== null) {
    next.delete("employee");
    if (alias !== "" && next.get("emp") === null) next.set("emp", alias);
    touched = true;
  }

  // `date` -> the `from`/`to` range this page actually filters on: one day, both ends.
  const day = next.get("date");
  if (day !== null) {
    next.delete("date");
    if (day !== "") {
      if (next.get("from") === null) next.set("from", day);
      if (next.get("to") === null) next.set("to", day);
    }
    touched = true;
  }

  // Flags settle on "1", the spelling this page's own controls write.
  for (const flag of ["review", "voided"] as const) {
    if (next.get(flag) === "true") {
      next.set(flag, "1");
      touched = true;
    }
  }

  return touched ? next : null;
}
