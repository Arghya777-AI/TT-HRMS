/**
 * OvertimeRulesCard — "how is my overtime worked out, and how does it become comp-off".
 *
 * WHY IT EXISTS. Both numbers were computed correctly and explained nowhere. An employee
 * saw `2:30` of overtime on a day and half a comp-off day for a Sunday, with no way to
 * check either — and the two are produced by DIFFERENT branches of the engine from
 * DIFFERENT columns, which is the misunderstanding this card exists to prevent:
 *
 *   * a normal working day past its shift  → OVERTIME (`overtime_minutes`)
 *   * a weekly off or holiday worked       → EXTRA WORK (`extra_work_minutes`), and it
 *                                            is extra work, never overtime, that earns
 *                                            comp-off
 *
 * Somebody who works four hours on their weekly off earns half a comp-off day and zero
 * overtime. Somebody who works four hours past a weekday shift earns overtime and zero
 * comp-off. Stated plainly here because the alternative is learning it from a number
 * that looks wrong.
 *
 * THE NUMBERS ARE READ, NOT WRITTEN INTO THE COPY. `4 hours = half a day` is true at
 * this venue today and becomes false the moment an administrator edits the policy. The
 * sentences carry the shape of the rule; the figures come from the same policy and shift
 * rows the engine reads, resolved through the same `resolve_policy`.
 *
 * IT SAYS WHEN OVERTIME CANNOT ARISE AT ALL. Three flags gate the branch — the policy's
 * `overtime_enabled`, the employee's `is_ot_eligible` and the designation's
 * `ot_eligible` — and the first is visible here. A card that explained a formula which
 * can never run for this person would be worse than no card.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CalendarClock, Info } from "lucide-react";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fmtCivilTime, fmtDurationHm, istToday } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { useMyEmployee } from "@/features/home/hooks/useHome";
import { fetchMyOvertimeRules } from "../api/overtimeRules.api";

export function OvertimeRulesCard() {
  const employeeId = useEmployeeId();
  const meQuery = useMyEmployee();
  const shiftId = meQuery.data?.shift_id ?? null;
  const today = istToday();

  const rules = useQuery({
    queryKey: qk.leave.detail(`ot-rules:${employeeId ?? "none"}:${shiftId ?? "none"}:${today}`),
    queryFn: ({ signal }) =>
      fetchMyOvertimeRules(employeeId ?? "", today, shiftId, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });

  const policy = rules.data?.policy ?? null;
  const shift = rules.data?.shift ?? null;

  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="flex items-center gap-2 font-display text-base font-semibold">
        <CalendarClock className="size-4 text-primary" aria-hidden />
        {t("leave.otRules.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("leave.otRules.subtitle")}</p>

      <StateBoundary
        loading={rules.isPending || meQuery.isPending}
        error={rules.error ?? meQuery.error}
        onRetry={() => void rules.refetch()}
        skeletonRows={3}
      >
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {/* ── Overtime ────────────────────────────────────────────────────── */}
          <div className="rounded-lg border bg-background/60 p-3">
            <h3 className="text-sm font-semibold">{t("leave.otRules.ot.heading")}</h3>

            {shift === null ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("leave.otRules.ot.noShift")}</p>
            ) : policy !== null && !policy.overtime_enabled ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("leave.otRules.ot.disabled")}</p>
            ) : (
              <>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("leave.otRules.ot.shiftLine", {
                    name: shift.name,
                    start: fmtCivilTime(shift.start_time),
                    end: fmtCivilTime(shift.end_time),
                    hours: fmtDurationHm(shift.duration_minutes),
                  })}
                </p>

                {/* The equation, laid out rather than written into a sentence — an
                    employee checking a figure wants to see the subtraction. */}
                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t("leave.otRules.ot.step1")}</dt>
                    <dd className="num shrink-0 tabular-nums">
                      {fmtDurationHm(shift.duration_minutes)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t("leave.otRules.ot.step2")}</dt>
                    <dd className="num shrink-0 tabular-nums">
                      {fmtDurationHm(shift.ot_threshold_minutes)}
                    </dd>
                  </div>
                  {policy !== null ? (
                    <>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">{t("leave.otRules.ot.step3")}</dt>
                        <dd className="num shrink-0 tabular-nums">
                          {fmtDurationHm(policy.overtime_min_minutes)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">{t("leave.otRules.ot.step4")}</dt>
                        <dd className="num shrink-0 tabular-nums">
                          {t("leave.otRules.ot.roundingValue", {
                            n: formatNumber(policy.overtime_rounding_minutes),
                          })}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">{t("leave.otRules.ot.step5")}</dt>
                        <dd className="num shrink-0 tabular-nums">
                          {fmtDurationHm(policy.max_overtime_minutes_per_day)}
                        </dd>
                      </div>
                    </>
                  ) : null}
                </dl>

                <p className="mt-3 rounded-md bg-muted/60 px-2 py-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
                  {t("leave.otRules.ot.example", {
                    threshold: fmtDurationHm(shift.ot_threshold_minutes),
                    shift: fmtDurationHm(shift.duration_minutes),
                  })}
                </p>
              </>
            )}

            {shift !== null && (shift.grace_in_minutes ?? 0) > 0 ? (
              <p className="mt-2 text-[0.7rem] text-muted-foreground">
                {t("leave.otRules.ot.grace", {
                  start: fmtCivilTime(shift.start_time),
                  minutes: formatNumber(shift.grace_in_minutes ?? 0),
                })}
              </p>
            ) : null}
          </div>

          {/* ── Comp-off ────────────────────────────────────────────────────── */}
          <div className="rounded-lg border bg-background/60 p-3">
            <h3 className="text-sm font-semibold">{t("leave.otRules.compOff.heading")}</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("leave.otRules.compOff.intro")}
            </p>

            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("leave.otRules.compOff.half")}</dt>
                <dd className="num shrink-0 tabular-nums">
                  {fmtDurationHm(policy?.comp_off_min_minutes ?? 240)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("leave.otRules.compOff.full")}</dt>
                <dd className="num shrink-0 tabular-nums">
                  {fmtDurationHm(policy?.comp_off_full_day_minutes ?? 480)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("leave.otRules.compOff.expiry")}</dt>
                <dd className="num shrink-0 tabular-nums">
                  {t("leave.otRules.compOff.expiryValue", {
                    n: formatNumber(policy?.comp_off_expiry_days ?? 90),
                  })}
                </dd>
              </div>
            </dl>

            {/* The approval path, which already exists and which nobody was told about. */}
            <ol className="mt-3 space-y-1 text-[0.7rem] leading-relaxed text-muted-foreground">
              <li>{t("leave.otRules.compOff.step1")}</li>
              <li>{t("leave.otRules.compOff.step2")}</li>
              <li>{t("leave.otRules.compOff.step3")}</li>
              <li>{t("leave.otRules.compOff.step4")}</li>
            </ol>

            <p className="mt-3 flex items-start gap-1.5 text-[0.7rem] text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              {t("leave.otRules.compOff.notOvertime")}
            </p>

            {/*
              THE MANUAL ROUTE, and it deliberately fixes the CAUSE rather than the symptom.

              When somebody worked an off day and it was never recorded, the missing thing
              is the attendance, not the credit. Filing a regularization creates the
              correction punches, and `decide_regularization` recomputes the day
              synchronously on approval — the recompute calls `sync_comp_off_for_day`, so
              the credit appears by the same rule as every automatic one.

              A separate "claim a comp-off day" form would have been a second way to mint a
              credit, with its own approval and no attendance behind it. Two sources of
              truth for the same balance, and the manual one unauditable against the day it
              claims to come from.
            */}
            <div className="mt-3 rounded-md border border-dashed p-2.5">
              <p className="text-xs font-medium">{t("leave.otRules.manual.heading")}</p>
              <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
                {t("leave.otRules.manual.body")}
              </p>
              <ol className="mt-1.5 space-y-0.5 text-[0.7rem] leading-relaxed text-muted-foreground">
                <li>{t("leave.otRules.manual.step1")}</li>
                <li>{t("leave.otRules.manual.step2")}</li>
                <li>{t("leave.otRules.manual.step3")}</li>
              </ol>
              <Button asChild size="sm" variant="outline" className="mt-2 h-7 text-xs">
                <Link to="/me/regularizations/new">{t("leave.otRules.manual.action")}</Link>
              </Button>
            </div>
          </div>
        </div>

        {policy !== null ? (
          <p className="mt-3 text-[0.7rem] text-muted-foreground">
            {t("leave.otRules.source", { policy: policy.name })}
          </p>
        ) : (
          <p className="mt-3 text-[0.7rem] text-muted-foreground">
            {t("leave.otRules.noPolicy")}
          </p>
        )}
      </StateBoundary>
    </section>
  );
}
