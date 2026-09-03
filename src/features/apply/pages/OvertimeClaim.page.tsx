/**
 * §Me · /me/apply/overtime — claim a month of credited overtime.
 *
 * ── WHAT THE VENUE ASKED FOR ─────────────────────────────────────────────────
 * "If they have completed one month attendance, and there are certain days where they have
 * worked extra — it should show summarised, whatever the extra work is. Can they submit it to
 * me saying, okay, the overtime I want to claim? It should come as an approval to me." And on
 * the outcome: "either you can be compensated, or we can give it as a compensatory off."
 *
 * ── THE NUMBER IS NOT TYPED IN, AND CANNOT BE ────────────────────────────────
 * There is no minutes field on this form. `submit_overtime_claim` sums the month from
 * `attendance_days` itself, and `overtime_claimable` — the same function — is what this screen
 * displays. So the figure shown and the figure filed are one figure, and an employee cannot
 * claim hours the engine never credited. That is what makes the approval a decision about
 * whether to PAY rather than an exercise in checking arithmetic, which is the part HR said they
 * did not want: "I don't want to keep on verifying all that."
 *
 * ── AND WHY A MONTH CAN SHOW HOURS IT WILL NOT LET YOU CLAIM ─────────────────
 * `overtime_minutes` derives from payable minutes, which include time still awaiting a punch
 * decision. Those days are withheld and SAID SO, because an employee who can see the hours on
 * their own attendance page needs to know why the claim is smaller — silence there reads as the
 * system losing their time.
 *
 * @route /me/apply/overtime
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { SelectField } from "@/features/admin/components/Field";
import { useAuth } from "@/app/auth/AuthProvider";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fmtCivilMonth, fmtDurationHm, istToday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  COMPENSATION_MODES,
  fetchMyOvertimeClaims,
  fetchOvertimeClaimable,
  submitOvertimeClaim,
  type CompensationMode,
} from "../api/overtime-claim.api";

/** The venue's own floor for a reason anybody reads later. Also enforced in the function. */
const MIN_REASON = 15;

/**
 * The last six COMPLETED months, newest first.
 *
 * A month still running is excluded rather than offered-and-refused: the function rejects it,
 * and letting somebody pick it only to be told no is a worse way to learn the rule.
 */
function completedMonths(today: string): string[] {
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  for (let back = 1; back <= 6; back += 1) {
    const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`);
  }
  return out;
}

export function OvertimeClaimPage() {
  const { employee } = useAuth();
  const queryClient = useQueryClient();
  const months = useMemo(() => completedMonths(istToday()), []);
  const [month, setMonth] = useState(months[0] ?? "");
  const [mode, setMode] = useState<CompensationMode>("comp_off");
  const [reason, setReason] = useState("");
  const [filed, setFiled] = useState<string | null>(null);

  const employeeId = employee?.employeeId ?? null;

  const claimable = useQuery({
    queryKey: qk.apply.list({ part: "overtime-claimable", employeeId, month }),
    enabled: employeeId !== null && month !== "",
    queryFn: ({ signal }) =>
      fetchOvertimeClaimable(employeeId as string, month, signal),
    retry: shouldRetryQuery,
  });

  const mine = useQuery({
    queryKey: qk.apply.list({ part: "overtime-claims" }),
    queryFn: ({ signal }) => fetchMyOvertimeClaims(signal),
    retry: shouldRetryQuery,
  });

  const submit = useMutation({
    mutationFn: () => submitOvertimeClaim(month, mode, reason),
    onSuccess: () => {
      setFiled(month);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: qk.apply.all });
    },
  });

  const c = claimable.data;
  const reasonTooShort = reason.trim().length < MIN_REASON;
  const nothingToClaim = (c?.claimable_minutes ?? 0) <= 0;
  const blocked = c?.already_claimed === true || nothingToClaim || reasonTooShort;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("apply.ot.title")}
        subtitle={t("apply.ot.subtitle")}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <section className="rounded-lg border bg-card p-4">
          <SelectField
            label={t("apply.ot.month")}
            value={month}
            onChange={setMonth}
            options={months.map((m) => ({ value: m, label: fmtCivilMonth(m.slice(0, 7)) }))}
          />

          <StateBoundary
            loading={claimable.isPending}
            error={claimable.error}
            onRetry={() => void claimable.refetch()}
          >
            {c === undefined || c === null ? null : (
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("apply.ot.credited")}
                </p>
                <p
                  className={cn(
                    "num text-3xl font-semibold tabular-nums",
                    c.claimable_minutes > 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {fmtDurationHm(c.claimable_minutes)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("apply.ot.creditedHint", { days: String(c.days_with_overtime) })}
                </p>

                {/*
                  SAID, NOT SWALLOWED. The employee can see these hours on their own attendance
                  page; if the claim is smaller and nothing explains why, the system looks like
                  it lost their time.
                */}
                {c.withheld_minutes > 0 ? (
                  <div className="mt-3">
                    <Notice tone="warning">
                      {t("apply.ot.withheld", {
                        held: fmtDurationHm(c.withheld_minutes),
                        days: String(c.days_withheld),
                      })}
                    </Notice>
                  </div>
                ) : null}

                {c.already_claimed ? (
                  <div className="mt-3">
                    <Notice tone="info">{t("apply.ot.alreadyClaimed")}</Notice>
                  </div>
                ) : null}
              </div>
            )}
          </StateBoundary>

          {/* ── What they want for it ─────────────────────────────────────── */}
          <fieldset className="mt-5 border-t pt-4" disabled={submit.isPending}>
            <legend className="text-xs font-medium text-muted-foreground">
              {t("apply.ot.mode")}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {COMPENSATION_MODES.map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? "default" : "outline"}
                  onClick={() => setMode(m)}
                >
                  {m === "paid" ? t("apply.ot.mode.paid") : t("apply.ot.mode.compOff")}
                </Button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
              {mode === "comp_off" ? t("apply.ot.mode.compOffHint") : t("apply.ot.mode.paidHint")}
            </p>

            <label htmlFor="ot-reason" className="mt-4 block text-xs font-medium">
              {t("apply.ot.reason")}
            </label>
            <textarea
              id="ot-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={800}
              placeholder={t("apply.ot.reasonPlaceholder")}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p
              className={cn(
                "mt-1 text-[11px] tabular-nums",
                reasonTooShort ? "text-muted-foreground" : "text-success",
              )}
            >
              {t("apply.ot.reasonCounter", {
                n: String(reason.trim().length),
                min: String(MIN_REASON),
              })}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button disabled={blocked || submit.isPending} onClick={() => submit.mutate()}>
                {submit.isPending ? t("apply.ot.filing") : t("apply.ot.file")}
              </Button>
              {/*
                The server's own sentence, shown as-is. Every refusal here is a rule with a
                number in it — the month is not over, the hours are awaiting punch approvals, a
                comp-off would round to nothing — and paraphrasing would lose the number.
              */}
              {submit.error !== null ? (
                <span className="text-xs text-destructive">{String(submit.error.message)}</span>
              ) : null}
              {filed !== null ? (
                <span className="text-xs text-success">
                  {t("apply.ot.filed", { month: fmtCivilMonth(filed.slice(0, 7)) })}
                </span>
              ) : null}
            </div>
          </fieldset>
        </section>

        {/* ── What they have already claimed ─────────────────────────────── */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="font-display text-sm font-semibold">{t("apply.ot.mineTitle")}</h2>
          <StateBoundary
            loading={mine.isPending}
            error={mine.error}
            onRetry={() => void mine.refetch()}
            isEmpty={mine.data !== undefined && mine.data.length === 0}
            empty={<p className="mt-2 text-sm text-muted-foreground">{t("apply.ot.mineEmpty")}</p>}
          >
            <ul className="mt-2 space-y-2">
              {(mine.data ?? []).map((row) => (
                <li key={row.id} className="rounded-md border p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {fmtCivilMonth(row.period_month.slice(0, 7))}
                    </span>
                    <span className="num text-sm tabular-nums">
                      {fmtDurationHm(row.claimed_minutes)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.compensation === "paid"
                      ? t("apply.ot.mode.paid")
                      : t("apply.ot.mode.compOff")}
                    {" · "}
                    {row.status}
                    {row.applied_at !== null ? ` · ${t("apply.ot.applied")}` : ""}
                  </p>
                  {row.decided_comment !== null && row.decided_comment !== "" ? (
                    <p className="mt-1 break-words text-xs">{row.decided_comment}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </StateBoundary>
        </section>
      </div>
    </div>
  );
}

export default OvertimeClaimPage;
