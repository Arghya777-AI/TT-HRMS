/**
 * weeklyOff.ts — rendering a `weekly_off_rules` row as a SENTENCE.
 *
 * DR-60: the reference product printed "First Weekly Off Sunday / Weeks
 * 1,2,3,4,5 · Second Weekly Off Saturday / Weeks 1,2,3,4,5" and left the reader
 * to work out what their week looked like. One sentence —
 * "Sunday every week + 2nd & 4th Saturday" — is the acceptance criterion.
 *
 * Pure formatting of stored configuration. Nothing here derives an attendance
 * number; whether a given date is an off day is `is_weekly_off()` in Postgres.
 */
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { dowLabel, weekLabel } from "./fields";

/** The subset of the rule row this renderer reads. */
export interface WeeklyOffShape {
  readonly rule_kind: string;
  readonly first_off_dow: number | null;
  readonly first_off_weeks: number[] | null;
  readonly second_off_dow: number | null;
  readonly second_off_weeks: number[] | null;
  readonly third_off_dow: number | null;
  readonly third_off_weeks: number[] | null;
  readonly offs_per_week: number | null;
  readonly half_day_dow: number | null;
  readonly is_rotational: boolean;
  readonly rotation_pattern?: unknown;
  readonly rotation_anchor_date: string | null;
}

const ALL_WEEKS = 5;

function dayPhrase(dow: number | null, weeks: number[] | null): string | null {
  if (dow === null) return null;
  const day = dowLabel(dow);
  if (weeks === null || weeks.length === 0 || weeks.length >= ALL_WEEKS) {
    return t("admin.time.woff.sentence.everyWeek", { day });
  }
  return t("admin.time.woff.sentence.someWeeks", {
    ordinals: weeks.map((week) => weekLabel(week)).join(t("admin.time.woff.sentence.andJoin")),
    day,
  });
}

function rotationDays(pattern: unknown): string[] {
  if (!Array.isArray(pattern)) return [];
  return pattern
    .map((entry) => (typeof entry === "number" ? dowLabel(entry) : null))
    .filter((label): label is string => label !== null);
}

/** The whole rule in one readable line. */
export function weeklyOffSentence(rule: WeeklyOffShape): string {
  if (rule.rule_kind === "roster_driven") return t("admin.time.woff.sentence.roster");

  if (rule.rule_kind === "days_per_week") {
    return t("admin.time.woff.sentence.perWeek", { count: rule.offs_per_week ?? 0 });
  }

  if (rule.is_rotational || rule.rule_kind === "rotational") {
    const days = rotationDays(rule.rotation_pattern);
    if (days.length === 0) return t("admin.time.woff.sentence.none");
    const joined = days.join(t("admin.time.woff.sentence.andJoin"));
    return rule.rotation_anchor_date === null
      ? t("admin.time.woff.sentence.rotatingNoAnchor", { days: joined })
      : t("admin.time.woff.sentence.rotating", {
          days: joined,
          date: fmtCivilDate(rule.rotation_anchor_date),
        });
  }

  const parts = [
    dayPhrase(rule.first_off_dow, rule.first_off_weeks),
    dayPhrase(rule.second_off_dow, rule.second_off_weeks),
    dayPhrase(rule.third_off_dow, rule.third_off_weeks),
  ].filter((part): part is string => part !== null);

  const pattern =
    parts.length === 0
      ? t("admin.time.woff.sentence.none")
      : parts.join(t("admin.time.woff.sentence.join"));

  if (rule.half_day_dow === null) return pattern;
  return t("admin.time.woff.sentence.withHalfDay", {
    pattern,
    halfDay: t("admin.time.woff.sentence.halfDay", { day: dowLabel(rule.half_day_dow) }),
  });
}
