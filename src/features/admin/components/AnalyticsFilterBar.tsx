/**
 * AnalyticsFilterBar — the ONE filter control every analytics surface mounts.
 *
 * WHAT THE CLIENT ASKED FOR
 * -------------------------
 *   "I should be able to select 2025 and July, or any particular week, or any
 *    particular day… Department-wise and employee-wise, everything can be
 *    filtered… On every details page, the same filters should apply."
 *
 * So there is one bar, not one per screen, and it owns nothing: it reads
 * `AnalyticsFilters` out of the URL through `useAnalyticsFilters` and writes
 * every change straight back. Two screens cannot drift apart about what "July"
 * means, and a tile's drill-through inherits the exact question by copying the
 * query string.
 *
 * WHY NATIVE `<select>` AND NOT A POPOVER
 * ---------------------------------------
 * Same call `Field.tsx` already made for the leave and payroll filters: a native
 * select is keyboard- and screen-reader-correct with no code, and at 360px it
 * opens the platform picker instead of a cramped floating list. Every control
 * here is 44px tall — this bar is used on the floor, on a tablet, by somebody
 * who is not sitting down.
 *
 * WHY OPTIONS ARRIVE AS PROPS
 * ---------------------------
 * Departments and locations come from the caller (whatever the analytics data
 * layer's `fetchFilterOptions` ends up returning) rather than from a query
 * inside this component. The bar then has no data dependency, renders in a test
 * with two literals, and a surface that already loaded its departments does not
 * pay for them twice.
 *
 * Every transition it performs lives in `../analyticsFilterBar`, under test.
 */
import { useId, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { GRANULARITIES, type Granularity } from "@/lib/period";
import {
  SOURCE_FILTERS,
  activeDimensionCount,
  clearDimensions,
  type SourceFilter,
} from "@/lib/analyticsFilters";
import { t } from "@/shared/i18n/en";
import {
  GRANULARITY_LABEL_KEY,
  GRANULARITY_UNIT_KEY,
  RESET_LABEL_KEY,
  SOURCE_LABEL_KEY,
  canStepBack,
  canStepForward,
  isAtPresent,
  periodLabel,
  resetFilters,
  steppedFilters,
  withDimension,
  withGranularity,
  withRangeEnd,
  withRangeStart,
  withSource,
  type AnalyticsDimension,
} from "../analyticsFilterBar";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";

/**
 * A dimension option: the id filtered on, the name shown. Structurally the
 * `RefOption` the org-master hooks already return, so `useRefOptions("departments")`
 * plugs in with no mapping.
 */
export interface AnalyticsFilterOption {
  readonly id: string;
  readonly name: string;
}

export interface AnalyticsFilterBarProps {
  readonly departments?: readonly AnalyticsFilterOption[];
  readonly locations?: readonly AnalyticsFilterOption[];
  /** Options still in flight — the dropdowns disable rather than showing an empty list. */
  readonly optionsLoading?: boolean;
  /**
   * Who `employeeId` refers to, for the drill-down chip. Without it the chip
   * says "One employee", which is still better than a filter counted but unseen.
   */
  readonly employeeName?: string;
  /** Dimensions this surface cannot honour — e.g. a view with no location column. */
  readonly hide?: readonly AnalyticsDimension[];
  /** Earliest civil date the caller has data for; below it "previous" is disabled. */
  readonly minDate?: string;
  readonly className?: string;
}

const CONTROL =
  "h-11 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Label above control, so the bar reads as a form and not as a row of mystery boxes. */
function BarField({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function AnalyticsFilterBar({
  departments,
  locations,
  optionsLoading = false,
  employeeName,
  hide,
  minDate,
  className,
}: AnalyticsFilterBarProps) {
  const { filters, setFilters } = useAnalyticsFilters();
  const { period } = filters;
  const hidden = (dimension: AnalyticsDimension): boolean => hide?.includes(dimension) ?? false;

  // Generated, not hard-coded: a page may mount this bar twice (a header and a
  // sticky copy), and two <label for="af-from"> would point at the same input.
  const uid = useId();
  const fieldId = (name: string): string => `${uid}-${name}`;

  /**
   * A row for an id the options list does not contain — because the options are
   * still in flight, or the URL was shared after that department was archived.
   * Without it the browser falls back to the first `<option>` and the control
   * reads "All departments" while the URL still narrows to one: a filter applied
   * and denied in the same breath, which is the single fastest way to lose an
   * argument about a number.
   */
  const unlisted = (
    selected: string | undefined,
    options: readonly AnalyticsFilterOption[] | undefined,
  ): ReactNode =>
    selected !== undefined && !(options ?? []).some((option) => option.id === selected) ? (
      <option value={selected}>
        {optionsLoading ? t("app.loading") : t("analytics.filter.unlisted")}
      </option>
    ) : null;

  const unit = t(GRANULARITY_UNIT_KEY[period.granularity]);
  const activeCount = activeDimensionCount(filters);
  const back = canStepBack(period, minDate);
  const forward = canStepForward(period);

  return (
    <section
      aria-label={t("analytics.filter.region")}
      className={cn("rounded-lg border bg-card p-3 shadow-sm", className)}
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <BarField id={fieldId("granularity")} label={t("analytics.filter.granularity")}>
          <select
            id={fieldId("granularity")}
            className={cn(CONTROL, "w-[9.5rem]")}
            value={period.granularity}
            onChange={(event) => {
              setFilters(withGranularity(filters, event.target.value as Granularity));
            }}
          >
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {t(GRANULARITY_LABEL_KEY[g])}
              </option>
            ))}
          </select>
        </BarField>

        {/* Stepper — prev / the period in words / next, as MonthStepper reads. */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11"
            disabled={!back}
            aria-label={t("analytics.filter.previous", { unit })}
            onClick={() => {
              setFilters(steppedFilters(filters, -1));
            }}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span
            className="min-w-[13rem] px-2 text-center text-sm font-medium"
            aria-live="polite"
          >
            {periodLabel(period)}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11"
            disabled={!forward}
            aria-label={t("analytics.filter.next", { unit })}
            {...(forward ? {} : { title: t("analytics.filter.noFuture") })}
            onClick={() => {
              setFilters(steppedFilters(filters, 1));
            }}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            className="h-11 px-3"
            disabled={isAtPresent(filters)}
            onClick={() => {
              setFilters(resetFilters(filters));
            }}
          >
            {t(RESET_LABEL_KEY[period.granularity])}
          </Button>
        </div>

        {period.granularity === "range" ? (
          <>
            <BarField id={fieldId("from")} label={t("analytics.filter.from")}>
              <Input
                id={fieldId("from")}
                type="date"
                className="h-11 w-[10.5rem]"
                value={period.from}
                {...(minDate === undefined ? {} : { min: minDate })}
                onChange={(event) => {
                  setFilters(withRangeStart(filters, event.target.value));
                }}
              />
            </BarField>
            <BarField id={fieldId("to")} label={t("analytics.filter.to")}>
              <Input
                id={fieldId("to")}
                type="date"
                className="h-11 w-[10.5rem]"
                value={period.to}
                // The browser enforces what `withRangeEnd` would otherwise have to
                // correct: an end before the start returns no rows and looks
                // exactly like a period in which nothing happened.
                min={period.from}
                onChange={(event) => {
                  setFilters(withRangeEnd(filters, event.target.value));
                }}
              />
            </BarField>
          </>
        ) : null}

        {hidden("department") ? null : (
          <BarField id={fieldId("department")} label={t("analytics.filter.department")}>
            <select
              id={fieldId("department")}
              className={cn(CONTROL, "w-[12rem]")}
              disabled={optionsLoading}
              value={filters.departmentId ?? ""}
              onChange={(event) => {
                setFilters(withDimension(filters, "departmentId", event.target.value));
              }}
            >
              <option value="">
                {optionsLoading ? t("app.loading") : t("analytics.filter.allDepartments")}
              </option>
              {unlisted(filters.departmentId, departments)}
              {(departments ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </BarField>
        )}

        {hidden("location") ? null : (
          <BarField id={fieldId("location")} label={t("analytics.filter.location")}>
            <select
              id={fieldId("location")}
              className={cn(CONTROL, "w-[12rem]")}
              disabled={optionsLoading}
              value={filters.locationId ?? ""}
              onChange={(event) => {
                setFilters(withDimension(filters, "locationId", event.target.value));
              }}
            >
              <option value="">
                {optionsLoading ? t("app.loading") : t("analytics.filter.allLocations")}
              </option>
              {unlisted(filters.locationId, locations)}
              {(locations ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </BarField>
        )}

        {hidden("source") ? null : (
          <BarField id={fieldId("source")} label={t("analytics.filter.source")}>
            <select
              id={fieldId("source")}
              className={cn(CONTROL, "w-[11rem]")}
              value={filters.source}
              onChange={(event) => {
                setFilters(withSource(filters, event.target.value as SourceFilter));
              }}
            >
              {SOURCE_FILTERS.map((source) => (
                <option key={source} value={source}>
                  {t(SOURCE_LABEL_KEY[source])}
                </option>
              ))}
            </select>
          </BarField>
        )}
      </div>

      {/*
        The active-filter line. Its absence is the commonest way a dashboard
        loses an argument: a number looks wrong because a department chosen three
        clicks ago is still applied and nothing on screen admits it.
      */}
      {activeCount > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {activeCount === 1
              ? t("analytics.filter.activeOne")
              : t("analytics.filter.activeMany", { count: activeCount })}
          </span>

          {filters.employeeId !== undefined && !hidden("employee") ? (
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-input bg-background px-3 text-sm ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={t("analytics.filter.employeeRemove", {
                name: employeeName ?? t("analytics.filter.employeeOne"),
              })}
              onClick={() => {
                setFilters(withDimension(filters, "employeeId", null));
              }}
            >
              {employeeName ?? t("analytics.filter.employeeOne")}
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}

          <Button
            variant="ghost"
            className="h-11 px-3"
            title={t("analytics.filter.clearHint")}
            onClick={() => {
              // clearDimensions keeps the period by construction — clearing a
              // filter must never silently move the dates under the reader.
              setFilters(clearDimensions(filters));
            }}
          >
            <X className="mr-1 h-4 w-4" aria-hidden />
            {t("analytics.filter.clear")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
