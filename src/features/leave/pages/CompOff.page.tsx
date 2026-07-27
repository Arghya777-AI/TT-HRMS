/**
 * E-06 Comp-off `/me/comp-off` — credits, expiry colouring, why each was earned,
 * and the FIFO order they will be spent in.
 *
 * Every day figure on this page comes from `v_comp_off_balance`
 * (`available_days`, `expiring_within_30_days`, `nearest_expiry`, `open_credits`)
 * or from a `comp_off_ledger` row's own `days` / `days_remaining`. Nothing is
 * summed here. Where the deployed views publish no aggregate — days awaiting
 * approval, days already used — this page shows the individual credits instead of
 * inventing a total, because a browser-side comp-off sum is precisely the defect
 * class the rebuild exists to remove.
 *
 * "Why" is `earn_source`, stamped by the rollup from the source attendance day's
 * own status (`weekly_off_worked` / `holiday_worked`), and `earned_minutes` links
 * to that day so the claim is checkable.
 *
 * @route /me/comp-off
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, HeartHandshake, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { KpiTile } from "@/shared/ui/KpiTile";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtCivilDayMonthWeekday, fmtDurationHm } from "@/lib/datetime";
import { dash, EM_DASH } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { useCompOffBalance, useCompOffCredits } from "../hooks/useLeave";
import { useLeaveTypeRules } from "../hooks/useLeaveApply";
import type { CompOffCredit } from "../api/leave.api";
import {
  COMP_OFF_STATUS_MAP,
  earnSourceLabel,
  expiryBand,
  fmtDays,
  toneTextClass,
} from "../components/leave-vocab";

/** Statuses that can still be spent — the FIFO queue. */
const SPENDABLE = new Set(["available", "partially_used"]);

export default function CompOffPage() {
  const balance = useCompOffBalance();
  const credits = useCompOffCredits();
  const rules = useLeaveTypeRules();

  const compOffTypeId = useMemo(
    () => rules.data?.find((r) => r.is_comp_off)?.id ?? null,
    [rules.data],
  );
  const applyHref =
    compOffTypeId === null
      ? "/me/leave/apply"
      : `/me/leave/apply?type=${encodeURIComponent(compOffTypeId)}`;

  const rows = useMemo<readonly CompOffCredit[]>(() => credits.data ?? [], [credits.data]);
  const pending = rows.filter((r) => r.status === "pending_approval");

  /**
   * FIFO position, read off the server's `ORDER BY expires_on, earned_on_date`
   * — the same order `consume_comp_off` walks. This is a rank over rows the
   * server already sorted, not a re-sort or a computation.
   */
  const fifoRank = useMemo(() => {
    const map = new Map<string, { position: number; total: number }>();
    const queue = rows.filter((r) => SPENDABLE.has(r.status));
    queue.forEach((row, index) => {
      map.set(row.id, { position: index + 1, total: queue.length });
    });
    return map;
  }, [rows]);

  const columns: DataGridColumn<CompOffCredit>[] = [
    {
      key: "earned_on_date",
      header: t("compOff.col.earned"),
      render: (row) =>
        row.earned_on_date === null ? dash(null) : fmtCivilDayMonthWeekday(row.earned_on_date),
    },
    {
      key: "earn_source",
      header: t("compOff.col.why"),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate">{earnSourceLabel(row.earn_source)}</p>
          {row.event_reference === null ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {t("compOff.why.event", { ref: row.event_reference })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "earned_minutes",
      header: t("compOff.col.worked"),
      align: "right",
      hideBelow: "md",
      render: (row) =>
        row.earned_on_date === null ? (
          <span className="num">{fmtDurationHm(row.earned_minutes)}</span>
        ) : (
          <Link
            to={`/me/attendance/${row.earned_on_date}`}
            className="num underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("compOff.viewDay")}
          >
            {fmtDurationHm(row.earned_minutes)}
          </Link>
        ),
    },
    {
      key: "days",
      header: t("compOff.col.credit"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <div>
          <span className="num">{fmtDays(row.days)}</span>
          {row.days_remaining !== null && row.days_remaining !== row.days ? (
            <p className="num text-xs text-muted-foreground">{fmtDays(row.days_remaining)}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: "expires_on",
      header: t("compOff.col.expires"),
      render: (row) => {
        const band = expiryBand(row.expires_on);
        return (
          <div className="min-w-0">
            <p className="num">
              {row.expires_on === null ? t("compOff.expiry.none") : fmtCivilDate(row.expires_on)}
            </p>
            <p className={cn("text-xs", toneTextClass(band.tone))}>{band.note}</p>
          </div>
        );
      },
    },
    {
      key: "status",
      header: t("compOff.col.status"),
      render: (row) => {
        const rank = fifoRank.get(row.id);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusChip status={row.status} map={COMP_OFF_STATUS_MAP} />
            {rank?.position === 1 ? (
              <Badge variant="info">{t("compOff.fifo.next")}</Badge>
            ) : rank === undefined ? null : (
              <span className="num text-xs text-muted-foreground">
                {t("compOff.fifo.position", { position: rank.position, count: rank.total })}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "action",
      header: t("compOff.col.action"),
      align: "right",
      render: (row) =>
        SPENDABLE.has(row.status) ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={applyHref}>{t("compOff.use")}</Link>
          </Button>
        ) : (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ),
    },
  ];

  const bal = balance.data ?? null;

  return (
    <div>
      <PageHeader
        icon={HeartHandshake}
        title={t("compOff.title")}
        subtitle={t("compOff.subtitle")}
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <Link to="/me/leave">{t("leave.title")}</Link>
            </Button>
            {bal === null || compOffTypeId === null ? (
              <Button size="sm" disabled title={t("compOff.apply.noType")}>
                <CalendarPlus className="h-4 w-4" aria-hidden />
                {t("compOff.useAll")}
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link to={applyHref}>
                  <CalendarPlus className="h-4 w-4" aria-hidden />
                  {t("compOff.useAll")}
                </Link>
              </Button>
            )}
          </>
        }
      />

      <StateBoundary
        loading={balance.isLoading}
        error={balance.error}
        onRetry={() => void balance.refetch()}
        skeletonRows={2}
      >
        {bal === null ? (
          <div className="mb-6 rounded-lg border bg-card p-4">
            <p className="font-medium">{t("compOff.balance.missing.title")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("compOff.balance.missing.hint")}</p>
          </div>
        ) : (
          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile
              label={t("compOff.kpi.available")}
              value={fmtDays(bal.available_days)}
              tone={bal.available_days > 0 ? "success" : "neutral"}
              explainer={{
                formula: t("compOff.kpi.available.formula"),
                numbers: t("compOff.kpi.available.numbers", {
                  days: fmtDays(bal.available_days),
                  count: bal.open_credits,
                }),
              }}
            />
            <KpiTile
              label={t("compOff.kpi.expiring")}
              value={fmtDays(bal.expiring_within_30_days)}
              tone={bal.expiring_within_30_days > 0 ? "warn" : "neutral"}
              explainer={{
                formula: t("compOff.kpi.expiring.formula"),
                numbers: t("compOff.kpi.expiring.numbers", {
                  days: fmtDays(bal.expiring_within_30_days),
                  date: fmtCivilDate(bal.nearest_expiry),
                }),
              }}
            />
            <KpiTile
              label={t("compOff.kpi.nearest")}
              value={
                bal.nearest_expiry === null
                  ? t("compOff.expiry.none")
                  : fmtCivilDate(bal.nearest_expiry)
              }
              hint={expiryBand(bal.nearest_expiry).note}
              tone={expiryBand(bal.nearest_expiry).tone}
            />
            <KpiTile
              label={t("compOff.credits.title")}
              value={bal.open_credits}
              hint={t("compOff.fifo.hint")}
            />
          </div>
        )}
      </StateBoundary>

      {pending.length > 0 ? (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p>{t("compOff.awaiting.count", { count: pending.length })}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("compOff.awaiting.noTotal")}</p>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="comp-off-credits">
        <div className="mb-3">
          <h2 id="comp-off-credits" className="font-display text-lg font-semibold">
            {t("compOff.credits.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            <span className="font-medium">{t("compOff.fifo.title")}: </span>
            {t("compOff.fifo.hint")}
          </p>
        </div>

        <StateBoundary
          loading={credits.isLoading}
          error={credits.error}
          onRetry={() => void credits.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={HeartHandshake}
              title={t("compOff.empty.title")}
              hint={t("compOff.empty.hint")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/me/holidays">{t("shell.nav.holidays")}</Link>
                </Button>
              }
            />
          }
          partialError={rules.error}
          partialLabel={t("compOff.use")}
          skeletonRows={3}
        >
          <DataGrid<CompOffCredit>
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>
    </div>
  );
}
