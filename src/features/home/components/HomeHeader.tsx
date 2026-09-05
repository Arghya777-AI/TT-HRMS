/**
 * HomeHeader — who you are, what day it is, and what you are working, on one band.
 *
 * ── WHAT THIS REPLACED, AND WHY IT MATTERED ──────────────────────────────────
 * Home opened with THREE stacked full-width blocks before anything you could act on: a
 * PageHeader carrying the greeting and the date, a separate band carrying the shift and the
 * weekly off, and a paragraph about face enrolment. On a laptop the punch button sat below the
 * fold; on a phone it was most of a screen down. The one thing an employee opens this page to
 * do was the one thing they had to scroll for.
 *
 * The greeting and the shift are now one band, and the space they used to waste is where the
 * shift went: on a wide screen the left of this row is a name and a date, and the right — which
 * was empty — carries the shift and the weekly off. One band instead of two, and the punch card
 * starts within the first screen.
 *
 * ── TWO LAYOUTS, NOT ONE LAYOUT BENT ─────────────────────────────────────────
 * Below `sm` this is a column: identity first, then the working facts as a two-up row of small
 * labelled values. From `sm` it is a single row with the facts pushed right. That is a real
 * difference in arrangement, not the same row wrapping — a wrapped row put the shift under the
 * avatar at an awkward indent and left the right half empty anyway.
 */
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtCivilTime, fmtDateWeekday, fmtDurationHm, fmtTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useMyPhoto } from "@/features/profile/hooks/useMyPhoto";
import { greetingLine, initialsOf } from "../display";
import type { MyEmployeeHome, Shift, ShiftSource, WeeklyOffRule } from "../api/home.api";

export interface HomeHeaderProps {
  readonly me: MyEmployeeHome | null;
  readonly shift: Shift | null;
  readonly shiftSource: ShiftSource | null;
  readonly weeklyOffRule: WeeklyOffRule | null;
  readonly loading: boolean;
  readonly nowMs: number;
}

/** One labelled fact. Small, quiet, and the same shape on both layouts. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium">{children}</div>
    </div>
  );
}

export function HomeHeader({
  me,
  shift,
  shiftSource,
  weeklyOffRule,
  loading,
  nowMs,
}: HomeHeaderProps): React.JSX.Element {
  // Above the early return: hooks must run in the same order every render.
  const photo = useMyPhoto();

  if (loading) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border bg-card p-3.5">
        <Skeleton className="size-10 rounded-full" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-36" />
        </div>
        <Skeleton className="hidden h-9 w-64 sm:block" />
      </div>
    );
  }

  const shiftWindow =
    shift === null
      ? null
      : `${shift.name} · ${fmtCivilTime(shift.start_time)}–${fmtCivilTime(shift.end_time)}`;

  const facts = (
    <>
      <Fact label={t("home.greeting.shift")}>
        {shiftWindow === null ? (
          <span className="text-muted-foreground">{t("home.greeting.noShift")}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="num">{shiftWindow}</span>
            <Badge variant="neutral">
              {shiftSource === "assignment"
                ? t("home.greeting.shiftRostered")
                : t("home.greeting.shiftStandard")}
            </Badge>
            {shift?.crosses_midnight === true ? (
              <Badge variant="info">{t("home.greeting.crossesMidnight")}</Badge>
            ) : null}
            {/*
              The unpaid break is a footnote, not a headline. It was on its own line in the old
              band and cost a row of height on every visit to say "0h 00m" for most people.
            */}
            {shift !== null && shift.unpaid_break_minutes > 0 ? (
              <span className="text-xs font-normal text-muted-foreground">
                {t("home.greeting.break", {
                  minutes: fmtDurationHm(shift.unpaid_break_minutes),
                })}
              </span>
            ) : null}
          </span>
        )}
      </Fact>

      <Fact label={t("home.greeting.weeklyOff")}>
        {weeklyOffRule?.name ?? (
          <span className="text-muted-foreground">{t("home.greeting.noWeeklyOff")}</span>
        )}
      </Fact>
    </>
  );

  return (
    <header className="mb-4 rounded-xl border bg-card p-3.5">
      {/* ── Wide: identity left, the working facts in the space that was empty ── */}
      <div className="hidden items-center gap-6 sm:flex">
        <Avatar className="size-10 shrink-0">
          {photo.data?.url !== undefined ? (
            <AvatarImage src={photo.data.url} alt={me?.display_name ?? ""} />
          ) : null}
          <AvatarFallback>{initialsOf(me?.display_name ?? "")}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg font-semibold leading-tight">
            {greetingLine(me?.first_name ?? null, nowMs)}
          </h1>
          <p className="num mt-0.5 text-xs text-muted-foreground">
            {t("home.greeting.subtitle", {
              date: fmtDateWeekday(nowMs),
              time: fmtTime(nowMs),
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-6 border-l pl-6">{facts}</div>
      </div>

      {/* ── Narrow: identity, then the facts two-up underneath ── */}
      <div className="sm:hidden">
        <div className="flex items-center gap-3">
          <Avatar className="size-9 shrink-0">
            {photo.data?.url !== undefined ? (
              <AvatarImage src={photo.data.url} alt={me?.display_name ?? ""} />
            ) : null}
            <AvatarFallback>{initialsOf(me?.display_name ?? "")}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <h1 className="truncate font-display text-base font-semibold leading-tight">
              {greetingLine(me?.first_name ?? null, nowMs)}
            </h1>
            <p className="num text-[11px] text-muted-foreground">
              {t("home.greeting.subtitle", {
                date: fmtDateWeekday(nowMs),
                time: fmtTime(nowMs),
              })}
            </p>
          </div>
        </div>
        {/*
          Two-up rather than stacked: a phone has the width for two short labelled values side
          by side, and stacking them is two more rows between the greeting and the punch button.
        */}
        <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">{facts}</div>
      </div>
    </header>
  );
}
