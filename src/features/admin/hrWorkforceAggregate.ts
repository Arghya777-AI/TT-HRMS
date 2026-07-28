/**
 * hrWorkforceAggregate.ts — the arithmetic behind the Workforce & Org panel,
 * quarantined in a module that imports no network client, no clock and no
 * locale. Every function here is pure and takes its rows as an argument, which
 * is what makes `hrWorkforceAggregate.test.ts` able to pin the whole of it with
 * literals.
 *
 * WHY CLIENT AGGREGATION AT ALL — the same reasoning as analyticsAggregate.ts
 * ---------------------------------------------------------------------------
 * PostgREST cannot GROUP BY, and no deployed relation rolls `v_admin_employee`
 * up by designation, grade, tenure, age or any diversity attribute.
 * `v_headcount_daily` groups by (date × department × employment_type) only.
 * Asking Postgres for one `count=exact` per bucket is not an option either:
 * `nationality` is free text and `designation_name` is an open master list, so
 * the bucket vocabulary is not knowable before the rows are read. So the rows
 * are read once (bounded — see the caps in hr-workforce.api.ts) and counted
 * here, and every result ships an `AnalyticsProvenance` saying `computedBy:
 * "client"`.
 *
 * THE THREE RULES THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------
 *  1. HEADCOUNT HAS ONE DEFINITION. {@link isOnRollAt} is `date_of_join <= d
 *     AND (last_working_day IS NULL OR last_working_day >= d)` — character for
 *     character what `analytics.mv_headcount_daily` does (migration 036 §4).
 *     The snapshot and the trend line therefore cannot disagree, which they
 *     absolutely would if the snapshot used `employment_status` instead.
 *  2. EVERY BAND SHIPS ITS DENOMINATOR. Age is computed only where
 *     `date_of_birth` is recorded, and {@link BandBreakdown} carries both the
 *     denominator and the excluded count so the screen can state them. An
 *     employee with no date of birth is not aged zero; they are unknown.
 *  3. SMALL BUCKETS ARE NOT PUBLISHED. {@link suppressSmallBuckets} is the DPDP
 *     guard on the diversity measures — see its own comment for why merely
 *     hiding the sub-threshold bucket is not enough.
 *
 * A NOTE ON `null` KEYS. Unassigned is a real bucket, never a rounding error:
 * employees exist before they are placed in a department, and nationality can
 * be blank. A null key sorts last and the screen labels it; dropping it would
 * make the bars stop adding up to the headline, which is the classic "why is
 * the total bigger than the chart" complaint.
 */
import { addDays, daysBetween, type Period } from "@/lib/period";
import { MAX_TREND_POINTS, meanIgnoringNulls } from "./analyticsAggregate";

// -----------------------------------------------------------------------------
// The row shapes this module was written against
// -----------------------------------------------------------------------------

/**
 * The projection of `v_admin_employee` the panel needs, in the view's own
 * snake_case so a reader can check a measure against the SQL without
 * translating names. Structural: the zod-parsed row in hr-workforce.api.ts
 * satisfies it, so dropping a column from that schema breaks the call site at
 * compile time rather than producing an all-null bucket at runtime.
 */
export interface WorkforceEmployeeRow {
  readonly id: string;
  readonly employee_code: string;
  readonly display_name: string;
  readonly department_id: string | null;
  readonly department_name: string | null;
  readonly designation_name: string | null;
  readonly grade_name: string | null;
  readonly location_id: string | null;
  readonly location_name: string | null;
  readonly employment_type: string;
  readonly employment_status: string;
  readonly date_of_join: string | null;
  /** NULL means "still employed" — never a sentinel date (migration 008 §1.6). */
  readonly last_working_day: string | null;
  readonly date_of_birth: string | null;
  readonly reporting_manager_id: string | null;
  readonly reporting_manager_name: string | null;
  readonly gender: string | null;
  readonly category: string | null;
  readonly is_differently_abled: boolean;
  readonly nationality: string | null;
  readonly marital_status: string | null;
}

/**
 * The projection of `v_headcount_daily` the trend needs. The view's grain is
 * (as_of_date × department × employment_type), so several rows share a date and
 * {@link aggregateHeadcountTrend} sums them — that sum is the one piece of
 * client arithmetic in the trend, and the caption says so.
 */
export interface HeadcountDailyRow {
  readonly as_of_date: string;
  readonly headcount: number;
  readonly joiners: number;
  readonly exits: number;
}

// -----------------------------------------------------------------------------
// The as-at date
// -----------------------------------------------------------------------------

export interface AsOf {
  /** The IST civil date the snapshot describes. */
  readonly date: string;
  /** The period ends in the future, so the snapshot was pulled back to today. */
  readonly clamped: boolean;
  /**
   * The snapshot is historical. It matters because the DIMENSIONS on an
   * employee row (department, designation, grade, location) are as at NOW, not
   * as at `date` — somebody who transferred last week is counted in their new
   * department in a snapshot dated three months ago. The screen must say so.
   */
  readonly historical: boolean;
}

/**
 * Which date a headcount snapshot is taken at, given the selected period.
 *
 * Headcount is an AS-AT figure, not a period aggregate, so a period selects a
 * date rather than a range: the end of the period, or today when the period has
 * not finished yet. Taking `period.to` unclamped would count people who have
 * not started — a July snapshot on the 28th would include a joiner dated the
 * 30th and read as three heads the venue does not have.
 *
 * `today` is a parameter so this stays pure; the api layer passes `nowIstDate()`.
 */
export function resolveAsOf(period: Period, today: string): AsOf {
  // ISO civil dates sort lexicographically, so a string compare IS the ordering.
  const clamped = period.to > today;
  const date = clamped ? today : period.to;
  return { date, clamped, historical: date < today };
}

// -----------------------------------------------------------------------------
// Head-count membership
// -----------------------------------------------------------------------------

/**
 * Is this employee on roll on `asOfDate`?
 *
 * `date_of_join <= d AND (last_working_day IS NULL OR last_working_day >= d)`,
 * lifted verbatim from `analytics.mv_headcount_daily`. A NULL `date_of_join`
 * (a `pre_joining` row with no start date agreed) is NOT on roll — the matview
 * requires `date_of_join IS NOT NULL` for the same reason, and counting a
 * person with no start date would make the snapshot and the trend differ by
 * exactly the number of unconfirmed offers.
 *
 * The last working day is INCLUSIVE: someone whose last day is today was at
 * work today.
 */
export function isOnRollAt(
  row: Pick<WorkforceEmployeeRow, "date_of_join" | "last_working_day">,
  asOfDate: string,
): boolean {
  const joined = row.date_of_join;
  if (joined === null || joined > asOfDate) return false;
  const left = row.last_working_day;
  return left === null || left >= asOfDate;
}

/** The rows {@link isOnRollAt} accepts. Order is preserved. */
export function onRollAt(
  rows: readonly WorkforceEmployeeRow[],
  asOfDate: string,
): WorkforceEmployeeRow[] {
  return rows.filter((row) => isOnRollAt(row, asOfDate));
}

// -----------------------------------------------------------------------------
// Calendar arithmetic — pure string maths, no Date object, no clock
// -----------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole months elapsed between two civil dates, by the anniversary rule: the
 * count only increments on the day-of-month the earlier date fell on.
 *
 * Done on the STRING parts rather than through `Date`, because a Date-based
 * difference has to pick a timezone and this figure must not depend on one.
 * `null` for a malformed input, negative when `to` precedes `from` — callers
 * treat a negative as unusable rather than folding it into the first band.
 *
 * Month-end convention: somebody who joined on 31 January completes their first
 * month on 28 February only in the sense that 31 February does not exist, so
 * this returns 0 that day and 1 on 1 March. That is at most one day of skew at
 * a band boundary, and it is the convention every HR system that does not
 * silently shift dates ends up with.
 */
export function completedMonths(from: string, to: string): number | null {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return null;
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const fd = Number(from.slice(8, 10));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  const td = Number(to.slice(8, 10));
  const months = (ty - fy) * 12 + (tm - fm);
  return td < fd ? months - 1 : months;
}

/** Whole years elapsed, by the same anniversary rule. `null` when unusable. */
export function completedYears(from: string, to: string): number | null {
  const months = completedMonths(from, to);
  return months === null ? null : Math.floor(months / 12);
}

// -----------------------------------------------------------------------------
// Buckets
// -----------------------------------------------------------------------------

/**
 * One bar, one legend row, one table line.
 *
 * `key` is STABLE IDENTITY and is what a drill-through travels on. For
 * department and location it is the uuid — which is why this panel needs no
 * name resolution and cannot suffer the two-departments-share-a-name ambiguity
 * that `analytics.api.ts` has to caveat: the view carries `department_id`
 * directly, so two identically named departments stay two bars. For the
 * dimensions the view exposes only by name (designation, grade) the key IS the
 * name, and for an enum (employment type) it is the enum value.
 *
 * `key === null` means unassigned / not recorded, and it is a real bucket.
 */
export interface HeadcountBucket {
  readonly key: string | null;
  /** Human name where the dimension has one. Null alongside a null key. */
  readonly label: string | null;
  readonly count: number;
}

/** Nulls last; otherwise ordinal, NOT locale-aware — a chart must order the
 *  same way in every browser, and `localeCompare` does not. */
function compareNullableKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Biggest bucket first, key ascending as the tiebreak so the order is stable
 *  across two renders of the same data and across browsers. */
function compareBucket(a: HeadcountBucket, b: HeadcountBucket): number {
  return b.count !== a.count ? b.count - a.count : compareNullableKey(a.key, b.key);
}

/** A blank string is an absent value, not a bucket named "". */
function normaliseKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function tally(
  rows: readonly WorkforceEmployeeRow[],
  keyOf: (row: WorkforceEmployeeRow) => string | null,
  labelOf: (row: WorkforceEmployeeRow) => string | null,
): HeadcountBucket[] {
  const counts = new Map<string | null, { label: string | null; count: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { label: labelOf(row), count: 1 });
    else existing.count += 1;
  }
  const out: HeadcountBucket[] = [];
  for (const [key, { label, count }] of counts) out.push({ key, label, count });
  out.sort(compareBucket);
  return out;
}

/** The five headcount dimensions this panel can answer from the employee row. */
export type HeadcountDimension =
  | "department"
  | "designation"
  | "grade"
  | "location"
  | "employmentType";

/**
 * Headcount for one dimension. Department and location key on their uuid so the
 * bar can drill through `withFilters`; the rest key on the value itself,
 * because `AnalyticsFilters` has no dimension for them and there is nothing
 * honest to drill into.
 */
export function headcountBy(
  rows: readonly WorkforceEmployeeRow[],
  dimension: HeadcountDimension,
): HeadcountBucket[] {
  switch (dimension) {
    case "department":
      return tally(
        rows,
        (r) => normaliseKey(r.department_id),
        (r) => normaliseKey(r.department_name),
      );
    case "location":
      return tally(
        rows,
        (r) => normaliseKey(r.location_id),
        (r) => normaliseKey(r.location_name),
      );
    case "designation":
      return tally(
        rows,
        (r) => normaliseKey(r.designation_name),
        (r) => normaliseKey(r.designation_name),
      );
    case "grade":
      return tally(
        rows,
        (r) => normaliseKey(r.grade_name),
        (r) => normaliseKey(r.grade_name),
      );
    case "employmentType":
      return tally(
        rows,
        (r) => normaliseKey(r.employment_type),
        (r) => normaliseKey(r.employment_type),
      );
  }
}

// -----------------------------------------------------------------------------
// Span of control
// -----------------------------------------------------------------------------

/** Above this many direct reportees a span is called out rather than tabulated. */
export const WIDE_SPAN_THRESHOLD = 10;

export interface ManagerSpan {
  /** `employees.reporting_manager_id` — the identity the reportees point at. */
  readonly managerId: string;
  /** Read off a reportee's `reporting_manager_name`. Null if the view had none. */
  readonly managerName: string | null;
  /** Direct reportees WITHIN the current scope — see {@link SpanOfControl}. */
  readonly reportees: number;
  /**
   * True when the manager is themself one of the counted employees. False means
   * they sit outside the filter (another department, or already left), so their
   * reportee count here is only the part of their team the filter admits.
   */
  readonly inScope: boolean;
}

/**
 * Who has reportees, and how many.
 *
 * THE TRAP THIS TYPE EXISTS TO AVOID: "people who have reportees" and "people
 * holding the manager role" are different populations and this codebase can
 * produce both. {@link SpanOfControl.managers} is the FIRST — distinct non-null
 * `reporting_manager_id` values among the counted employees. The role count
 * comes from `public.user_roles` and is fetched, labelled and displayed
 * separately by hr-workforce.api.ts; the two are never added, averaged or
 * substituted for one another.
 *
 * SCOPE CAVEAT, stated because it changes the number: reportees are counted
 * among the IN-SCOPE rows. Filter to one department and a manager who sits in
 * another department still appears (their reportees are in scope) with only the
 * part of their team the filter admits. `inScope` is what tells the reader which
 * case they are looking at.
 */
export interface SpanOfControl {
  readonly headcount: number;
  /** Distinct non-null `reporting_manager_id`. NOT the manager-role grant count. */
  readonly managers: number;
  readonly peopleWithAManager: number;
  /** Nobody above them in the counted set — the top of the tree, or unassigned. */
  readonly peopleWithoutAManager: number;
  /** Every manager, widest span first. */
  readonly spans: readonly ManagerSpan[];
  /** Null when nobody has a reportee — never 0, which would read as "flat". */
  readonly maxReportees: number | null;
  readonly managersOverThreshold: number;
  /**
   * Headcount ÷ managers, the classic organisational span. Its denominator is
   * every counted head INCLUDING the managers and the people who report to
   * nobody, so it answers "how many people per manager does this org carry".
   * Null when there are no managers.
   */
  readonly spanOfControl: number | null;
  /**
   * Reportees ÷ managers — what a manager actually carries. Differs from
   * {@link spanOfControl} by the people with no manager, and the pair is shown
   * together because a big gap between them IS the finding (a flat top, or a
   * lot of unassigned reporting lines).
   */
  readonly meanReportees: number | null;
}

export const EMPTY_SPAN: SpanOfControl = {
  headcount: 0,
  managers: 0,
  peopleWithAManager: 0,
  peopleWithoutAManager: 0,
  spans: [],
  maxReportees: null,
  managersOverThreshold: 0,
  spanOfControl: null,
  meanReportees: null,
};

export function spanOfControl(rows: readonly WorkforceEmployeeRow[]): SpanOfControl {
  if (rows.length === 0) return EMPTY_SPAN;

  const byManager = new Map<string, { name: string | null; reportees: number }>();
  let withAManager = 0;
  for (const row of rows) {
    const managerId = normaliseKey(row.reporting_manager_id);
    if (managerId === null) continue;
    withAManager += 1;
    const existing = byManager.get(managerId);
    if (existing === undefined) {
      byManager.set(managerId, { name: normaliseKey(row.reporting_manager_name), reportees: 1 });
    } else {
      existing.reportees += 1;
      // First non-null name wins; a later reportee with a null name must not
      // erase a manager's name from the findings table.
      existing.name ??= normaliseKey(row.reporting_manager_name);
    }
  }

  const counted = new Set<string>();
  for (const row of rows) counted.add(row.id);

  const spans: ManagerSpan[] = [];
  for (const [managerId, { name, reportees }] of byManager) {
    spans.push({ managerId, managerName: name, reportees, inScope: counted.has(managerId) });
  }
  // Widest first; manager id as the tiebreak so equal spans order stably.
  spans.sort((a, b) =>
    b.reportees !== a.reportees ? b.reportees - a.reportees : compareNullableKey(a.managerId, b.managerId),
  );

  const managers = spans.length;
  let managersOverThreshold = 0;
  for (const span of spans) if (span.reportees > WIDE_SPAN_THRESHOLD) managersOverThreshold += 1;

  return {
    headcount: rows.length,
    managers,
    peopleWithAManager: withAManager,
    peopleWithoutAManager: rows.length - withAManager,
    spans,
    maxReportees: spans[0]?.reportees ?? null,
    managersOverThreshold,
    // Guarded rather than divided: no managers must give "unknown", not Infinity.
    spanOfControl: managers === 0 ? null : rows.length / managers,
    // The shared mean helper — returns null on an empty sample, which is the
    // only division-by-zero guard this line needs.
    meanReportees: meanIgnoringNulls(spans.map((s) => s.reportees)),
  };
}

// -----------------------------------------------------------------------------
// Tenure and age bands
// -----------------------------------------------------------------------------

export const TENURE_BANDS = ["lt3m", "m3to12", "y1to3", "y3plus"] as const;
export type TenureBand = (typeof TENURE_BANDS)[number];

export const AGE_BANDS = ["lt25", "a25to34", "a35to44", "a45to54", "a55plus"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * A banded distribution WITH its denominator.
 *
 * `denominator` is the people the bands were computed over and `excluded` the
 * people who had no usable source date. They are separate fields rather than
 * an "unknown" band because an unknown is not a position on the scale — putting
 * it on the same axis as "under 25" invites the reader to compare them.
 */
export interface BandBreakdown<B extends string> {
  readonly bands: readonly { readonly band: B; readonly count: number }[];
  readonly denominator: number;
  readonly excluded: number;
}

function emptyBands<B extends string>(all: readonly B[]): BandBreakdown<B> {
  return { bands: all.map((band) => ({ band, count: 0 })), denominator: 0, excluded: 0 };
}

export const EMPTY_TENURE: BandBreakdown<TenureBand> = emptyBands(TENURE_BANDS);
export const EMPTY_AGE: BandBreakdown<AgeBand> = emptyBands(AGE_BANDS);

/** Months of service → band. Negative (joined after the as-at date) is unusable. */
export function tenureBandOf(months: number): TenureBand | null {
  if (!Number.isFinite(months) || months < 0) return null;
  if (months < 3) return "lt3m";
  if (months < 12) return "m3to12";
  if (months < 36) return "y1to3";
  return "y3plus";
}

/** Years of age → band. Negative (a date of birth after the as-at date) is unusable. */
export function ageBandOf(years: number): AgeBand | null {
  if (!Number.isFinite(years) || years < 0) return null;
  if (years < 25) return "lt25";
  if (years < 35) return "a25to34";
  if (years < 45) return "a35to44";
  if (years < 55) return "a45to54";
  return "a55plus";
}

function bandCounts<B extends string>(
  all: readonly B[],
  rows: readonly WorkforceEmployeeRow[],
  bandOf: (row: WorkforceEmployeeRow) => B | null,
): BandBreakdown<B> {
  const counts = new Map<B, number>();
  for (const band of all) counts.set(band, 0);
  let denominator = 0;
  let excluded = 0;
  for (const row of rows) {
    const band = bandOf(row);
    if (band === null) {
      excluded += 1;
      continue;
    }
    counts.set(band, (counts.get(band) ?? 0) + 1);
    denominator += 1;
  }
  // Emitted in BAND order, not by size: an ordinal scale read out of order is
  // unreadable, and a zero band must keep its slot rather than vanish.
  return { bands: all.map((band) => ({ band, count: counts.get(band) ?? 0 })), denominator, excluded };
}

/**
 * Tenure from `date_of_join` at the as-at date.
 *
 * On a row set already filtered by {@link isOnRollAt}, `excluded` is 0 by
 * construction — that filter requires a join date on or before the as-at date.
 * It is still reported, because a caller who bands an unfiltered set must see
 * the people it could not place.
 */
export function tenureBands(
  rows: readonly WorkforceEmployeeRow[],
  asOfDate: string,
): BandBreakdown<TenureBand> {
  return bandCounts(TENURE_BANDS, rows, (row) => {
    if (row.date_of_join === null) return null;
    const months = completedMonths(row.date_of_join, asOfDate);
    return months === null ? null : tenureBandOf(months);
  });
}

/**
 * Age from `date_of_birth` at the as-at date — only where it is recorded.
 *
 * `date_of_birth` is nullable on `employees` and is genuinely blank for a good
 * part of a hospitality roster, so the excluded count is the number the screen
 * must print beside the ring. Treating a missing birth date as any band at all
 * would move the distribution by exactly the number of incomplete profiles.
 */
export function ageBands(
  rows: readonly WorkforceEmployeeRow[],
  asOfDate: string,
): BandBreakdown<AgeBand> {
  return bandCounts(AGE_BANDS, rows, (row) => {
    if (row.date_of_birth === null) return null;
    const years = completedYears(row.date_of_birth, asOfDate);
    return years === null ? null : ageBandOf(years);
  });
}

// -----------------------------------------------------------------------------
// Diversity — aggregate counts only, k-anonymised
// -----------------------------------------------------------------------------

/**
 * The k in k-anonymity for the diversity buckets. Three is the floor the brief
 * sets: a bucket of two in a department of two names those two people to
 * anybody who knows the department.
 */
export const MIN_PUBLISHABLE_BUCKET = 3;

export interface SuppressedBreakdown {
  /** Buckets large enough to publish, biggest first. */
  readonly kept: readonly HeadcountBucket[];
  /**
   * The merged withheld group, or null when nothing was withheld. Deliberately
   * carries only a total and a bucket COUNT — never the labels, because on a
   * free-text dimension like nationality the label is the identifying fact.
   */
  readonly withheld: { readonly people: number; readonly buckets: number } | null;
  /** Everybody the breakdown covers. `kept` + `withheld.people` = this. */
  readonly total: number;
  readonly minBucket: number;
}

export const EMPTY_SUPPRESSED: SuppressedBreakdown = {
  kept: [],
  withheld: null,
  total: 0,
  minBucket: MIN_PUBLISHABLE_BUCKET,
};

/**
 * Publish only buckets of at least `min` people, with COMPLEMENTARY SUPPRESSION.
 *
 * Hiding the small bucket on its own does not work, and this is the whole
 * reason this function is more than one `filter`:
 *
 *   * If exactly ONE bucket is withheld, the reader subtracts the published
 *     buckets from the total — which this panel prints a few tiles away — and
 *     recovers its exact size. So a second bucket is absorbed, smallest first.
 *   * If the withheld group still holds fewer than `min` people, it is itself a
 *     small bucket, so more are absorbed until it is not.
 *
 * The consequence on a BINARY dimension is total suppression, and that is
 * correct rather than a bug: with "differently abled = yes" at two people,
 * publishing "no = 198" beside a headcount of 200 discloses the two. The screen
 * says the dimension was withheld instead of showing a number that gives them
 * away.
 *
 * Ordering is preserved (biggest first) and `kept` never contains the merged
 * group — the caller renders that separately, as a labelled absence.
 */
export function suppressSmallBuckets(
  buckets: readonly HeadcountBucket[],
  min: number = MIN_PUBLISHABLE_BUCKET,
): SuppressedBreakdown {
  let total = 0;
  for (const bucket of buckets) total += bucket.count;

  const sorted = [...buckets].sort(compareBucket);
  const kept: HeadcountBucket[] = [];
  let withheldBuckets = 0;
  let withheldPeople = 0;
  for (const bucket of sorted) {
    if (bucket.count < min) {
      withheldBuckets += 1;
      withheldPeople += bucket.count;
    } else {
      kept.push(bucket);
    }
  }

  if (withheldBuckets === 0) return { kept: sorted, withheld: null, total, minBucket: min };

  // Absorb from the smallest published bucket upward until the withheld group
  // covers at least two categories AND at least `min` people. `kept` is sorted
  // descending, so `pop()` is the smallest.
  while (kept.length > 0 && (withheldBuckets < 2 || withheldPeople < min)) {
    const absorbed = kept.pop();
    if (absorbed === undefined) break;
    withheldBuckets += 1;
    withheldPeople += absorbed.count;
  }

  return {
    kept,
    withheld: { people: withheldPeople, buckets: withheldBuckets },
    total,
    minBucket: min,
  };
}

/** The five special-category / demographic dimensions, each already suppressed. */
export interface DiversityBreakdown {
  readonly gender: SuppressedBreakdown;
  readonly category: SuppressedBreakdown;
  /** Keys are exactly 'yes' and 'no' — `is_differently_abled` is NOT NULL. */
  readonly differentlyAbled: SuppressedBreakdown;
  readonly nationality: SuppressedBreakdown;
  readonly maritalStatus: SuppressedBreakdown;
}

export const EMPTY_DIVERSITY: DiversityBreakdown = {
  gender: EMPTY_SUPPRESSED,
  category: EMPTY_SUPPRESSED,
  differentlyAbled: EMPTY_SUPPRESSED,
  nationality: EMPTY_SUPPRESSED,
  maritalStatus: EMPTY_SUPPRESSED,
};

/**
 * Every diversity dimension, counted and suppressed.
 *
 * NO DRILL-THROUGH EXISTS FROM ANY OF THESE, deliberately, and this is the one
 * place the "everything drills" rule of this analytics surface is switched off.
 * Religion, category and disability are special-category personal data under
 * the DPDP Act; a link from "SC: 4" to a list of four named people is the exact
 * disclosure the Act is about, and it would be trivially reachable from a
 * dashboard that treats every bar as a filter. So these produce counts, the
 * counts are k-anonymised, and there is no id on the bucket to navigate with.
 *
 * (`religion` is a column on `employees` and is deliberately NOT read here or
 * projected by hr-workforce.api.ts: there is no workforce-planning measure that
 * needs it, and the safest way to not disclose a field is to not fetch it.)
 */
export function diversityBreakdown(
  rows: readonly WorkforceEmployeeRow[],
  min: number = MIN_PUBLISHABLE_BUCKET,
): DiversityBreakdown {
  const of = (keyOf: (row: WorkforceEmployeeRow) => string | null): SuppressedBreakdown =>
    suppressSmallBuckets(tally(rows, keyOf, keyOf), min);
  return {
    gender: of((r) => normaliseKey(r.gender)),
    category: of((r) => normaliseKey(r.category)),
    differentlyAbled: of((r) => (r.is_differently_abled ? "yes" : "no")),
    nationality: of((r) => normaliseKey(r.nationality)),
    maritalStatus: of((r) => normaliseKey(r.marital_status)),
  };
}

// -----------------------------------------------------------------------------
// The snapshot
// -----------------------------------------------------------------------------

export interface WorkforceAggregateOptions {
  readonly asOfDate: string;
  /**
   * The employee directory's own "currently employed" status set, passed in
   * rather than redeclared so this module and `employees.api.ts` cannot drift.
   * Used ONLY to count {@link WorkforceSnapshot.statusAnomalies}; it never
   * decides who is in the headcount.
   */
  readonly onRollStatuses: readonly string[];
  /** k-anonymity floor for the diversity buckets. */
  readonly minBucket?: number;
}

export interface WorkforceSnapshot {
  readonly asOfDate: string;
  /** People on roll at `asOfDate` — the denominator of every bar below. */
  readonly headcount: number;
  /** Rows fetched, before the as-at test. `rowsConsidered - headcount` have left. */
  readonly rowsConsidered: number;
  /**
   * Counted as at the date, yet carrying an `employment_status` outside the
   * directory's on-roll set — typically an `exited` row whose
   * `last_working_day` was never filled in. A DATA-QUALITY FINDING, and the
   * honest explanation for the gap between this headcount and the "on roll"
   * tile on /admin/analytics/workforce, which counts by status instead.
   */
  readonly statusAnomalies: number;
  readonly byDepartment: readonly HeadcountBucket[];
  readonly byDesignation: readonly HeadcountBucket[];
  readonly byGrade: readonly HeadcountBucket[];
  readonly byLocation: readonly HeadcountBucket[];
  readonly byEmploymentType: readonly HeadcountBucket[];
  readonly span: SpanOfControl;
  readonly tenure: BandBreakdown<TenureBand>;
  readonly age: BandBreakdown<AgeBand>;
  readonly diversity: DiversityBreakdown;
}

export function emptyWorkforceSnapshot(asOfDate: string): WorkforceSnapshot {
  return {
    asOfDate,
    headcount: 0,
    rowsConsidered: 0,
    statusAnomalies: 0,
    byDepartment: [],
    byDesignation: [],
    byGrade: [],
    byLocation: [],
    byEmploymentType: [],
    span: EMPTY_SPAN,
    tenure: EMPTY_TENURE,
    age: EMPTY_AGE,
    diversity: EMPTY_DIVERSITY,
  };
}

/**
 * Every measure on the panel, from one pass of the as-at filter and one pass
 * per dimension. Deliberately not fused into a single loop: nine small, named,
 * separately testable passes over a few hundred rows cost nothing, and a fused
 * accumulator is where a bucket quietly starts counting the wrong thing.
 */
export function aggregateWorkforce(
  rows: readonly WorkforceEmployeeRow[],
  opts: WorkforceAggregateOptions,
): WorkforceSnapshot {
  const { asOfDate, onRollStatuses, minBucket } = opts;
  const onRoll = onRollAt(rows, asOfDate);
  if (onRoll.length === 0) {
    return { ...emptyWorkforceSnapshot(asOfDate), rowsConsidered: rows.length };
  }

  const active = new Set(onRollStatuses);
  let statusAnomalies = 0;
  for (const row of onRoll) if (!active.has(row.employment_status)) statusAnomalies += 1;

  return {
    asOfDate,
    headcount: onRoll.length,
    rowsConsidered: rows.length,
    statusAnomalies,
    byDepartment: headcountBy(onRoll, "department"),
    byDesignation: headcountBy(onRoll, "designation"),
    byGrade: headcountBy(onRoll, "grade"),
    byLocation: headcountBy(onRoll, "location"),
    byEmploymentType: headcountBy(onRoll, "employmentType"),
    span: spanOfControl(onRoll),
    tenure: tenureBands(onRoll, asOfDate),
    age: ageBands(onRoll, asOfDate),
    diversity: diversityBreakdown(onRoll, minBucket),
  };
}

// -----------------------------------------------------------------------------
// Headcount trend
// -----------------------------------------------------------------------------

/**
 * One date on the trend.
 *
 * Every figure is nullable and `isEmpty` says why: the matview holds no row for
 * that date, which happens for every date after its last refresh and for every
 * date before the first employee joined. Plotting those as zero would draw the
 * venue losing its entire workforce overnight — the single most alarming thing
 * a headcount chart can invent.
 */
export interface HeadcountTrendPoint {
  readonly asOfDate: string;
  readonly isEmpty: boolean;
  readonly headcount: number | null;
  readonly joiners: number | null;
  readonly exits: number | null;
  /** Matview rows summed into this point — (department × employment type). */
  readonly rowsSummed: number;
}

/**
 * One point per IST date in the period, gaps included.
 *
 * `v_headcount_daily` is one row per (date × department × employment type), so
 * the org-wide figure for a date is the SUM of its rows. That sum is client
 * arithmetic and the panel's caption says so; there is no rollup row in the
 * matview to read instead (`v_headcount_monthly` groups by department too — its
 * "no department" row is a department, not a total).
 *
 * Dates found in `rows` but outside the period are appended rather than
 * dropped, and the output is capped at {@link MAX_TREND_POINTS} — both for the
 * reasons `aggregateDailyTrend` documents: a stray date that is counted
 * elsewhere but hidden here makes two panels disagree with no way to see why,
 * and a hand-edited ten-year "daily" URL must not freeze on 3,650 SVG nodes.
 */
export function aggregateHeadcountTrend(
  rows: readonly HeadcountDailyRow[],
  period: Period,
): HeadcountTrendPoint[] {
  const byDate = new Map<string, { headcount: number; joiners: number; exits: number; n: number }>();
  for (const row of rows) {
    const acc = byDate.get(row.as_of_date) ?? { headcount: 0, joiners: 0, exits: 0, n: 0 };
    acc.headcount += row.headcount;
    acc.joiners += row.joiners;
    acc.exits += row.exits;
    acc.n += 1;
    byDate.set(row.as_of_date, acc);
  }

  const dates: string[] = [];
  const seen = new Set<string>();
  const span = daysBetween(period.from, period.to);
  if (span >= 0) {
    const points = Math.min(span + 1, MAX_TREND_POINTS);
    for (let i = 0; i < points; i += 1) {
      const date = addDays(period.from, i);
      dates.push(date);
      seen.add(date);
    }
  }
  const strays: string[] = [];
  for (const date of byDate.keys()) if (!seen.has(date)) strays.push(date);
  strays.sort();
  dates.push(...strays);
  if (dates.length > MAX_TREND_POINTS) dates.length = MAX_TREND_POINTS;

  return dates.map((asOfDate) => {
    const acc = byDate.get(asOfDate);
    return acc === undefined
      ? { asOfDate, isEmpty: true, headcount: null, joiners: null, exits: null, rowsSummed: 0 }
      : {
          asOfDate,
          isEmpty: false,
          headcount: acc.headcount,
          joiners: acc.joiners,
          exits: acc.exits,
          rowsSummed: acc.n,
        };
  });
}
