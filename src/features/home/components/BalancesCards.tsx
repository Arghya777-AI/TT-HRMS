/**
 * Regions E and F — leave balances and comp-off.
 *
 * `available_days` and `available_after_pending` are GENERATED columns on
 * `leave_balances`; comp-off comes from `v_comp_off_balance`. Nothing here adds
 * opening + accrued − availed: the widget that did that is the defect being
 * removed (leave.api.ts header). Both cards read the SAME functions `/me/leave`
 * and `/me/comp-off` read, so they cannot disagree with those screens.
 *
 * Comp-off expiry colouring: amber ≤15 days, red ≤5 days (spec E-02 Region F).
 * The threshold is a calendar comparison against the server's `nearest_expiry`;
 * the DATE shown is always the column, never a computed countdown.
 *
 * ── THE RINGS ──────────────────────────────────────────────────────────────
 *
 * A balance card answers "how many". The question people actually arrive with is
 * "is that a lot", and that is a ratio — so each tile carries a ring of the two
 * columns its own explainer already spells out, and nothing else changes.
 *
 * Leave: `availed_days` against `entitlement_days`. Not `available` against
 * `entitlement` — available is a GENERATED column that has already had
 * encashment and lapses taken out of it, so available + availed is not the
 * entitlement and a ring drawn from that pair would quietly not add up. Taken
 * against entitled is one subtraction the server has already done.
 *
 * Comp-off: `expiring_within_30_days` against `available_days`. Both come from
 * `v_comp_off_balance`, where the first is the SAME sum as the second under a
 * `expires_on <= today + 30` filter — a genuine part of a genuine whole. The
 * ring takes its colour from the same band as the badge beside it, so the two
 * cannot say different things about the same urgency.
 */
import { Link } from "react-router-dom";
import { CalendarDays, HeartHandshake } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { ProgressRing } from "@/shared/ui/charts/ProgressRing";
import { CHART_TONE } from "@/shared/ui/charts/chartTokens";
import { fmtCivilDate } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { LeaveBalance } from "@/features/leave/api/leave.api";
import type { HomeBalances } from "../api/home.api";
import { expiryTone } from "../display";
import { Fact, HomeCard, RegionBody } from "./HomeCard";

function balanceSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}

export interface BalancesProps {
  query: UseQueryResult<HomeBalances, Error>;
}

/** Region E — one KPI tile per eligible leave type, comp-off excluded (it is F). */
export function LeaveBalancesCard({ query }: BalancesProps) {
  return (
    <HomeCard
      icon={CalendarDays}
      title={t("home.leave.title")}
      className="lg:col-span-2"
      action={
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/me/leave/apply">{t("home.leave.apply")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/me/leave">{t("home.leave.viewAll")}</Link>
          </Button>
        </div>
      }
    >
      <RegionBody
        query={query}
        skeleton={balanceSkeleton()}
        isEmpty={(data) => leaveTypesOnly(data.leave).length === 0}
        empty={
          <EmptyState
            icon={CalendarDays}
            title={t("home.leave.empty.title")}
            hint={t("home.leave.empty.hint")}
          />
        }
      >
        {(data) => (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {leaveTypesOnly(data.leave).map((b) => (
              <LeaveTile key={b.leave_type_id} balance={b} />
            ))}
          </div>
        )}
      </RegionBody>
    </HomeCard>
  );
}

/** Comp-off has its own region; a type absent from the view is simply not eligible. */
function leaveTypesOnly(balances: readonly LeaveBalance[]): LeaveBalance[] {
  return balances.filter((b) => !b.is_comp_off);
}

function LeaveTile({ balance }: { balance: LeaveBalance }) {
  const available = formatNumber(balance.available_days);
  const held = formatNumber(balance.pending_days);
  const used = formatNumber(balance.availed_days);
  const entitlement = formatNumber(balance.entitlement_days);
  return (
    <KpiTile
      label={balance.leave_type_name}
      value={t("home.unit.days", { count: available })}
      hint={`${t("home.leave.held")} ${held} · ${t("home.leave.used")} ${used}`}
      tone={balance.available_days > 0 ? "neutral" : "warn"}
      explainer={{
        formula: t("home.leave.explainer.formula"),
        numbers: t("home.leave.explainer.numbers", { available, held, used, entitlement }),
      }}
      /*
        NO ENTITLEMENT, NO RING. Migration 038600 sets `annual_quota_days = 0`
        for every type except SL and EL, so most employees carry several types
        entitled to nothing — and a ring with a zero denominator is not a poor
        chart, it is a chart of a question that does not exist. The tile still
        prints the figures either way.
      */
      visual={
        balance.entitlement_days > 0 ? (
          <ProgressRing
            size={56}
            value={balance.availed_days}
            total={balance.entitlement_days}
            centre={used}
            caption={t("home.chart.leave.caption", { entitlement })}
            title={t("home.chart.leave.title", {
              type: balance.leave_type_name,
              used,
              entitlement,
            })}
            /* Leave is `info` everywhere else on the screen — the sky day cells
               in the month calendar, the leave chips — so it is `info` here. */
            color={CHART_TONE.leave}
          />
        ) : undefined
      }
    />
  );
}

/** Region F — comp-off: available, open credits, nearest expiry with its band. */
export function CompOffCard({ query }: BalancesProps) {
  return (
    <HomeCard
      icon={HeartHandshake}
      title={t("home.compOff.title")}
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/me/comp-off">{t("home.compOff.use")}</Link>
        </Button>
      }
    >
      <RegionBody
        query={query}
        skeleton={<Skeleton className="h-24" />}
        isEmpty={(data) => data.compOff === null}
        empty={
          <EmptyState
            icon={HeartHandshake}
            title={t("home.compOff.empty.title")}
            hint={t("home.compOff.empty.hint")}
          />
        }
      >
        {(data) => {
          const compOff = data.compOff;
          if (compOff === null) return null;
          const tone = expiryTone(compOff.nearest_expiry);
          const available = formatNumber(compOff.available_days);
          const expiring = formatNumber(compOff.expiring_within_30_days);
          /*
            THE SAME BAND AS THE BADGE UNDERNEATH, deliberately. That badge is
            `danger` on the ≤5-day band and `warning` on everything else it
            appears for, and `CHART_TONE.absent` / `CHART_TONE.late` ARE
            `--destructive` / `--warning`. Nothing expiring gets the muted ring:
            an empty amber circle would read as a warning about nothing.
          */
          const ringColor =
            compOff.expiring_within_30_days <= 0
              ? CHART_TONE.neutral
              : tone === "danger"
                ? CHART_TONE.absent
                : CHART_TONE.late;
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                {/* A balance of zero has no whole for the expiring days to be a
                    part of, so the ring stays away and the facts stand alone. */}
                {compOff.available_days > 0 ? (
                  <ProgressRing
                    className="shrink-0"
                    size={84}
                    value={compOff.expiring_within_30_days}
                    total={compOff.available_days}
                    centre={expiring}
                    caption={t("home.chart.compOff.caption", { available })}
                    title={t("home.chart.compOff.title", { expiring, available })}
                    color={ringColor}
                  />
                ) : null}
                {/*
                  The two facts stack into ONE column now that the ring shares the
                  row. Side by side in the third of a grid this card occupies they
                  had about 90px each, which is where `Fact`'s `truncate` starts
                  eating expiry dates — and a truncated date is the one thing on
                  this card nobody can afford to misread.
                */}
                <dl className="grid min-w-0 flex-1 gap-3">
                  <Fact
                    label={t("home.compOff.available")}
                    value={t("home.unit.days", { count: available })}
                  />
                  <Fact
                    label={t("home.compOff.nearestExpiry")}
                    value={
                      compOff.nearest_expiry === null
                        ? t("home.compOff.noExpiry")
                        : fmtCivilDate(compOff.nearest_expiry)
                    }
                    tone={tone === "neutral" ? "default" : tone}
                  />
                </dl>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="neutral">
                  {t("home.compOff.credits", { count: formatNumber(compOff.open_credits) })}
                </Badge>
                {compOff.expiring_within_30_days > 0 ? (
                  <Badge variant={tone === "danger" ? "danger" : "warning"}>
                    {t("home.compOff.expiringSoon", { days: expiring })}
                  </Badge>
                ) : null}
              </div>
              {compOff.nearest_expiry !== null && tone !== "neutral" ? (
                <p className={tone === "danger" ? "text-sm text-destructive" : "text-sm text-warning"}>
                  {tone === "danger"
                    ? t("home.compOff.expiryUrgent", {
                        date: fmtCivilDate(compOff.nearest_expiry),
                      })
                    : t("home.compOff.expiryWarn", { date: fmtCivilDate(compOff.nearest_expiry) })}
                </p>
              ) : null}
            </div>
          );
        }}
      </RegionBody>
    </HomeCard>
  );
}
