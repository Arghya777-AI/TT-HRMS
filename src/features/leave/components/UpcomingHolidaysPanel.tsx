/**
 * UpcomingHolidaysPanel — the holidays ahead, on the screen everybody opens.
 *
 * ── WHY THIS COULD NOT BE SEEN BEFORE ────────────────────────────────────────
 * The holidays existed all along — nineteen of them, seven still ahead — and almost nobody
 * could see any. `employees.holiday_calendar_id` is NULL on 80 of the venue's 83 rows, only
 * three were ever set, and every consumer read that column straight. `useHolidaysInWindow` is
 * `enabled: calendarId.length > 0`, so for those 80 people the holiday query never ran at all.
 *
 * The calendar is assigned at COMPANY scope, which is exactly what `resolve_policy` is for and
 * what migration 20260801040000 already wrote down as a rule: the rota is resolved, not read
 * off the employee. `fetchMyLeaveContext` now resolves it, so this panel gets a real id for
 * everybody and the fix reaches every other screen that reads the same context.
 *
 * ── OPTIONAL HOLIDAYS ARE MARKED, NOT HIDDEN ─────────────────────────────────
 * An optional holiday is a day somebody may take and is not automatically off. Listing it
 * unmarked would have people planning around a day they are expected to work.
 */
import { CalendarDays } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { addIstDays, fmtCivilDayMonthWeekday, istToday } from "@/lib/datetime";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { useHolidaysInWindow, useMyLeaveContext } from "../hooks/useLeaveApply";

/** A quarter ahead: long enough to see the next festival, short enough to stay a list. */
const WINDOW_DAYS = 120;

export function UpcomingHolidaysPanel(): React.JSX.Element {
  const from = istToday();
  const to = addIstDays(from, WINDOW_DAYS);
  const context = useMyLeaveContext();
  const holidays = useHolidaysInWindow(context.data?.holiday_calendar_id ?? null, from, to);

  /*
    The context has to load before the calendar id exists, so its loading state is part of this
    panel's. Without that the panel flashes "no holidays" for as long as the context is in
    flight — which is the wrong sentence, said confidently.
  */
  const loading = context.isLoading || holidays.isLoading;
  const noCalendar = !context.isLoading && (context.data?.holiday_calendar_id ?? null) === null;

  return (
    <section className="mt-4 rounded-xl border bg-card p-4">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {t("leave.holidays.title")}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.holidays.subtitle")}</p>

      <StateBoundary
        loading={loading}
        error={holidays.error ?? context.error ?? undefined}
        onRetry={() => {
          void context.refetch();
          void holidays.refetch();
        }}
        skeletonRows={2}
      >
        {noCalendar ? (
          /* Says which setting is missing, rather than implying the venue has no holidays. */
          <p className="mt-3 text-sm text-muted-foreground">{t("leave.holidays.noCalendar")}</p>
        ) : (holidays.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("leave.holidays.empty")}</p>
        ) : (
          <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {(holidays.data ?? []).map((h) => (
              <li key={h.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{h.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {fmtCivilDayMonthWeekday(h.holiday_date)}
                  </span>
                </span>
                {h.is_optional ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("leave.holidays.optional")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </StateBoundary>
    </section>
  );
}
