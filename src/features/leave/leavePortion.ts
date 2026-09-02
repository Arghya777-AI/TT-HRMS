/**
 * leavePortion.ts — is this a half day or a full day, said the same way everywhere.
 *
 * ── WHY IT IS A MODULE AND NOT A TERNARY ─────────────────────────────────────
 * Four screens show who is on leave — the dashboard's calendar band, the org calendar's
 * month grid and its list, and the employee's own calendar — and none of them said whether the
 * day was a half or a full one. An admin looking at "Jyothikanth · Week-off" could not tell
 * that he was in for the afternoon.
 *
 * Four ternaries would drift. The specific way they drift here is worth naming: `portion` and
 * `day_value` disagree on a weekly off. A half-day request on a rostered off-day is stored with
 * `portion = 'first_half'` and `day_value = 0.000`, because `count_weekly_off_as_leave` is false
 * for that type — the shape of the request is a half day, the cost is nothing. A screen that
 * read `day_value` would call it a full day; one that read `portion` would say half. Both are
 * defensible and they must not appear on the same page.
 *
 * `portion` wins, because the question these screens answer is "will this person be here this
 * afternoon", not "what did it cost their balance".
 */
import { t } from "@/shared/i18n/en";

export type LeavePortion = "full_day" | "first_half" | "second_half";

export function isHalfDay(portion: string): boolean {
  return portion === "first_half" || portion === "second_half";
}

/** `Half day (first half)`, or `Full day`. Short enough to sit inside a calendar cell. */
export function portionText(portion: string): string {
  switch (portion) {
    case "first_half":
      return t("leave.portion.firstHalf");
    case "second_half":
      return t("leave.portion.secondHalf");
    default:
      return t("leave.portion.fullDay");
  }
}

/** The one-word form, for a badge or a dense grid where the half matters less than the fact. */
export function portionShort(portion: string): string {
  return isHalfDay(portion) ? t("leave.portion.halfShort") : t("leave.portion.fullShort");
}
