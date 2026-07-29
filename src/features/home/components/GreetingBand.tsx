/**
 * Region A — the greeting band (spec-employee §5 E-02).
 *
 * Today's shift is the one the roster resolves (a dated `shift_assignments` row
 * overriding `employees.shift_id`, §3.3), rendered as `name` + window — never the
 * bare code and never `shifts.display_label`, which the DB builds as
 * `'G — 09:30 AM to 06:30 PM'`: bare code plus 12h, both banned (DR-53, §8).
 *
 * The weekly off is `weekly_off_rules.name`, which is already the sentence form
 * DR-60 requires ("Sunday + Alternate Saturday"); nothing is assembled here from
 * the dow/weeks arrays.
 */
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtCivilTime, fmtDurationHm } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useMyPhoto } from "@/features/profile/hooks/useMyPhoto";
import type { MyEmployeeHome, Shift, ShiftSource, WeeklyOffRule } from "../api/home.api";
import { initialsOf } from "../display";

export interface GreetingBandProps {
  me: MyEmployeeHome | null;
  shift: Shift | null;
  shiftSource: ShiftSource | null;
  weeklyOffRule: WeeklyOffRule | null;
  loading: boolean;
}

export function GreetingBand({
  me,
  shift,
  shiftSource,
  weeklyOffRule,
  loading,
}: GreetingBandProps) {
  // Above the loading early-return: hooks must run in the same order every render.
  const photo = useMyPhoto();

  if (loading) {
    return (
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        <Skeleton className="h-11 w-11 rounded-full" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-5 w-44" />
      </div>
    );
  }

  const shiftWindow = (s: Shift): string =>
    `${s.name} · ${fmtCivilTime(s.start_time)}–${fmtCivilTime(s.end_time)}`;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-card p-4">
      <Avatar className="h-11 w-11">
        {/* That endpoint now exists. `document-access` mints the signed URL and
            `useMyPhoto` caches it under its own expiry; initials remain the fallback
            for anybody who has not uploaded a picture, or whose link failed. */}
        {photo.data?.url !== undefined ? (
          <AvatarImage src={photo.data.url} alt={me?.display_name ?? ""} />
        ) : null}
        <AvatarFallback>{initialsOf(me?.display_name ?? "")}</AvatarFallback>
      </Avatar>

      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("home.greeting.shift")}
        </p>
        {shift === null ? (
          <p className="text-sm text-muted-foreground">{t("home.greeting.noShift")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="num">{shiftWindow(shift)}</span>
            <Badge variant="neutral">
              {shiftSource === "assignment"
                ? t("home.greeting.shiftRostered")
                : t("home.greeting.shiftStandard")}
            </Badge>
            {shift.crosses_midnight ? (
              <Badge variant="info">{t("home.greeting.crossesMidnight")}</Badge>
            ) : null}
            {shift.unpaid_break_minutes > 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("home.greeting.break", { minutes: fmtDurationHm(shift.unpaid_break_minutes) })}
              </span>
            ) : null}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t("home.greeting.weeklyOff")}
        </p>
        <p className="text-sm font-medium">
          {weeklyOffRule?.name ?? (
            <span className="text-muted-foreground">{t("home.greeting.noWeeklyOff")}</span>
          )}
        </p>
      </div>
    </div>
  );
}
