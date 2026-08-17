/**
 * /admin/leave/rollover — what the year end will do to every leave balance
 * (spec-admin §7.3: "dry-run → review → commit → lock year").
 *
 * HONEST LIMIT, READ IT BEFORE LOOKING FOR THE BUTTON. The commit half of that
 * sentence has no backend on this deployment, and the screen says so rather than
 * offering a control that cannot work:
 *   * `leave_ledger` grants INSERT to `service_role` only, and
 *     `leave_ledger_guard_mutation()` refuses client mutation outright — so
 *     `carry_forward_in` / `lapse` / `encashment` rows cannot be written from a
 *     browser at all;
 *   * migration 019 ships `accrue_leave`, `expire_comp_off`,
 *     `recompute_leave_balance`, `consume_comp_off`, `calc_leave_days` and
 *     `rebuild_leave_request_days` — there is no `rollover_leave_year`, and no
 *     edge function stands in for one;
 *   * `leave_year_rollovers` is readable by any admin but writable only by
 *     `app.is_super_admin()`, and a row written without the ledger work behind it
 *     would be a false record of a rollover that never happened.
 *
 * So this screen is the REVIEW step, built entirely from deployed relations:
 *
 *  1. THE RULEBOOK, per type, from `leave_types` — `carry_forward_allowed`,
 *     `max_carry_forward_days`, `carry_forward_expiry_months`,
 *     `max_balance_days`, `encashment_allowed`, `max_encashment_days` — stated in
 *     words, in this venue's own numbers.
 *  2. THE EXPOSURE, as SERVER COUNTS over `v_leave_balance_current`: how many
 *     employee × type records hold a balance, and how many hold MORE than that
 *     type's own carry-forward cap (`available_days > cap`, a Postgres
 *     predicate). Those are the people who lose days unless something is done
 *     first. No days are summed and no per-person split is projected: the split
 *     belongs to the job that will write it, and a browser-computed preview that
 *     later disagreed with the ledger would be worse than no preview at all.
 *  3. THE HISTORY, from `leave_year_rollovers` — what previous runs actually
 *     carried, lapsed and encashed, dry-run or committed.
 *
 * The leave year comes from Postgres (`leave_year_of(ist_today())`), never from a
 * browser calendar: April basis, so 2026 is FY 2026-27.
 *
 * @route /admin/leave/rollover
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Cog, CalendarDays, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatDays, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { LeaveType } from "../api/leave.api";
import type { RolloverRun } from "../api/leave-config.api";
import { CountTile } from "../components/CountTile";
import { Notice } from "../components/Notice";
import { unavailableHint } from "../command-vocab";
import {
  ROLLOVER_STATUS_CHIP,
  encashmentRule,
  leaveYearLabel,
  rolloverRule,
} from "../leave-config-vocab";
import { useAdminLeaveTypes } from "../hooks/useAdminLeave";
import { useCurrentLeaveYear } from "../hooks/useAnalyticsWorkforce";
import {
  carryForwardCap,
  useBalanceRecordCount,
  useRolloverRuns,
  useRolloverTypeCounts,
  type RolloverTypeCounts,
} from "../hooks/useLeaveConfig";

/** A count in a grid cell: the number, or an honest reason it is missing. */
function CountCell({
  query,
}: {
  query: { data: number | undefined; error: Error | null; isPending: boolean } | null;
}) {
  if (query === null) return <span className="text-muted-foreground">{dash(null)}</span>;
  if (query.error !== null)
    return (
      <span className="text-xs text-muted-foreground" title={unavailableHint(query.error)}>
        {dash(null)}
      </span>
    );
  if (query.isPending) return <span className="text-muted-foreground">{dash(null)}</span>;
  return <span className="num">{formatNumber(query.data ?? 0)}</span>;
}

export default function AdminLeaveRolloverPage() {
  const leaveYear = useCurrentLeaveYear();
  const types = useAdminLeaveTypes();
  const runs = useRolloverRuns();

  /** Types whose balance survives the year end, and types that may be encashed. */
  const carryTypes = useMemo(
    () => (types.data ?? []).filter((type) => type.carry_forward_allowed && !type.is_comp_off),
    [types.data],
  );
  const encashTypes = useMemo(
    () => (types.data ?? []).filter((type) => type.encashment_allowed),
    [types.data],
  );

  /**
   * Only the types that HAVE a balance to roll: the comp-off type expires through
   * `comp_off_ledger` (90 days, `expire_comp_off`) rather than at year end, and a
   * type with no quota and no accrual never holds one.
   */
  const rollableTypes = useMemo(
    () =>
      (types.data ?? []).filter(
        (type) => !type.is_comp_off && (type.annual_quota_days !== null || type.carry_forward_allowed),
      ),
    [types.data],
  );

  const carryTypeIds = useMemo(() => carryTypes.map((type) => type.id), [carryTypes]);
  const encashTypeIds = useMemo(() => encashTypes.map((type) => type.id), [encashTypes]);

  const allRecords = useBalanceRecordCount({}, "all");
  const withBalance = useBalanceRecordCount({ availableAbove: 0 }, "withBalance");
  const carryEligible = useBalanceRecordCount(
    { leaveTypeIds: carryTypeIds, availableAbove: 0 },
    "carryEligible",
    carryTypeIds.length > 0,
  );
  const encashEligible = useBalanceRecordCount(
    { leaveTypeIds: encashTypeIds, availableAbove: 0 },
    "encashEligible",
    encashTypeIds.length > 0,
  );

  const typeCounts = useRolloverTypeCounts(rollableTypes);

  const fromYear = leaveYear.data ?? null;
  // `ck_lyr__years` requires `to_leave_year > from_leave_year`, and the leave year
  // is an FY start year, so the destination year is the next one. This is a label,
  // not a business figure — every days figure on the screen is a server column.
  const toYear = fromYear === null ? null : fromYear + 1;

  const typeColumns: DataGridColumn<RolloverTypeCounts>[] = [
    {
      key: "type",
      header: t("adminLeave.rollover.col.type"),
      width: "13rem",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.type.name}</span>
          <span className="num text-xs text-muted-foreground">{row.type.code}</span>
        </span>
      ),
    },
    {
      key: "rule",
      header: t("adminLeave.rollover.col.rule"),
      render: (row) => <span className="text-sm">{rolloverRule(row.type)}</span>,
    },
    {
      key: "cap",
      header: t("adminLeave.rollover.col.cap"),
      width: "8rem",
      align: "right",
      render: (row) => {
        const cap = carryForwardCap(row.type);
        return <span className="num">{cap === null ? dash(null) : formatDays(cap)}</span>;
      },
    },
    {
      key: "encash",
      header: t("adminLeave.rollover.col.encash"),
      width: "14rem",
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{encashmentRule(row.type)}</span>,
    },
    {
      key: "withBalance",
      header: t("adminLeave.rollover.col.holding"),
      width: "9rem",
      align: "right",
      render: (row) => <CountCell query={row.withBalance} />,
    },
    {
      key: "aboveCap",
      header: t("adminLeave.rollover.col.aboveCap"),
      width: "10rem",
      align: "right",
      render: (row) => (
        <span className={row.aboveCap !== null && (row.aboveCap.data ?? 0) > 0 ? "text-warning" : ""}>
          <CountCell query={row.aboveCap} />
        </span>
      ),
    },
    {
      key: "drill",
      header: t("adminLeave.rollover.col.open"),
      width: "9rem",
      align: "right",
      render: (row) => (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/admin/leave/balances?type=${row.type.id}`}>
            {t("adminLeave.rollover.openBalances")}
          </Link>
        </Button>
      ),
    },
  ];

  const typeName = (id: string | null): string => {
    if (id === null) return t("adminLeave.rollover.allTypes");
    const found: LeaveType | undefined = (types.data ?? []).find((type) => type.id === id);
    return found?.name ?? t("adminLeave.rollover.retiredType");
  };

  const runColumns: DataGridColumn<RolloverRun>[] = [
    {
      key: "years",
      header: t("adminLeave.rollover.col.years"),
      width: "13rem",
      render: (row) => (
        <span className="flex items-center gap-1.5 text-sm">
          <span className="num">{leaveYearLabel(row.from_leave_year)}</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="num">{leaveYearLabel(row.to_leave_year)}</span>
        </span>
      ),
    },
    {
      key: "leave_type_id",
      header: t("adminLeave.rollover.col.scope"),
      width: "11rem",
      render: (row) => typeName(row.leave_type_id),
    },
    {
      key: "status",
      header: t("adminLeave.rollover.col.status"),
      width: "10rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip status={row.status} map={ROLLOVER_STATUS_CHIP} />
          <span className="text-xs text-muted-foreground">
            {row.dry_run
              ? t("adminLeave.rollover.dryRun")
              : t("adminLeave.rollover.committed")}
          </span>
        </span>
      ),
    },
    {
      key: "run_at",
      header: t("adminLeave.rollover.col.runAt"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => <span className="num text-xs">{fmtDateTime(row.run_at)}</span>,
    },
    {
      key: "employees_processed",
      header: t("adminLeave.rollover.col.employees"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatNumber(row.employees_processed)}</span>,
    },
    {
      key: "days_carried",
      header: t("adminLeave.rollover.col.carried"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatDays(row.days_carried)}</span>,
    },
    {
      key: "days_lapsed",
      header: t("adminLeave.rollover.col.lapsed"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatDays(row.days_lapsed)}</span>,
    },
    {
      key: "days_encashed",
      header: t("adminLeave.rollover.col.encashed"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{formatDays(row.days_encashed)}</span>,
    },
    {
      key: "error_detail",
      header: t("adminLeave.rollover.col.detail"),
      hideBelow: "lg",
      render: (row) => (
        <span className="text-xs text-muted-foreground">{dash(row.error_detail)}</span>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("adminLeave.rollover.title")}
        subtitle={t("adminLeave.rollover.subtitle")}
      />

      {/*
        A NOTE, NOT A WARNING. There is nothing here for an administrator to fix:
        the rollover job does not exist on this deployment, which is a fact about
        the build rather than about their leave data. Drawn in amber behind a
        triangle it read as an error somebody had to chase.
      */}
      <Notice tone="note" className="mb-5">
        <p className="font-medium">{t("adminLeave.rollover.noEngine.title")}</p>
        <p className="mt-1">{t("adminLeave.rollover.noEngine.body")}</p>
      </Notice>

      <section className="mb-5 rounded-lg border bg-card p-5">
        <h2 className="font-display text-base font-semibold">
          {t("adminLeave.rollover.window.heading")}
        </h2>
        {leaveYear.error !== null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {unavailableHint(leaveYear.error)}
          </p>
        ) : (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-lg">
            <span className="num font-semibold">
              {fromYear === null ? dash(null) : leaveYearLabel(fromYear)}
            </span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="num font-semibold">
              {toYear === null ? dash(null) : leaveYearLabel(toYear)}
            </span>
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          {t("adminLeave.rollover.window.hint")}
        </p>
      </section>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <CountTile
          label={t("adminLeave.rollover.tile.records")}
          hint={t("adminLeave.rollover.tile.recordsHint")}
          to="/admin/leave/balances"
          drillLabel={t("adminLeave.rollover.tile.recordsDrill")}
          source={t("adminLeave.rollover.source.balances")}
          query={allRecords}
        />
        <CountTile
          label={t("adminLeave.rollover.tile.withBalance")}
          hint={t("adminLeave.rollover.tile.withBalanceHint")}
          to="/admin/leave/balances"
          drillLabel={t("adminLeave.rollover.tile.withBalanceDrill")}
          source={t("adminLeave.rollover.source.balances")}
          query={withBalance}
        />
        {/* A tile whose scope is empty has nothing to count, and a count with no
            type predicate would silently report the whole organisation under a
            "carries forward" heading. It states the rulebook fact instead. */}
        {types.isSuccess && carryTypes.length === 0 ? (
          <KpiTile
            label={t("adminLeave.rollover.tile.carry")}
            value={t("common.empty")}
            hint={t("adminLeave.rollover.tile.noCarryTypes")}
            to="/admin/leave/types"
            drillLabel={t("adminLeave.rollover.openTypes")}
          />
        ) : (
          <CountTile
            label={t("adminLeave.rollover.tile.carry")}
            hint={t("adminLeave.rollover.tile.carryHint", { types: carryTypes.length })}
            to="/admin/leave/balances"
            drillLabel={t("adminLeave.rollover.tile.carryDrill")}
            source={t("adminLeave.rollover.source.balances")}
            query={carryEligible}
          />
        )}
        {types.isSuccess && encashTypes.length === 0 ? (
          <KpiTile
            label={t("adminLeave.rollover.tile.encash")}
            value={t("common.empty")}
            hint={t("adminLeave.rollover.tile.noEncashTypes")}
            to="/admin/leave/types"
            drillLabel={t("adminLeave.rollover.openTypes")}
          />
        ) : (
          <CountTile
            label={t("adminLeave.rollover.tile.encash")}
            hint={t("adminLeave.rollover.tile.encashHint", { types: encashTypes.length })}
            to="/admin/leave/encashment"
            drillLabel={t("adminLeave.rollover.tile.encashDrill")}
            source={t("adminLeave.rollover.source.balances")}
            query={encashEligible}
          />
        )}
      </div>

      <section className="mb-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminLeave.rollover.rules.heading")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("adminLeave.rollover.rules.hint")}
        </p>
        <StateBoundary
          loading={types.isLoading}
          error={types.error ?? undefined}
          onRetry={() => void types.refetch()}
          skeletonRows={5}
        >
          <DataGrid
            columns={typeColumns}
            rows={typeCounts}
            rowKey={(row) => row.type.id}
            pageSize={25}
            emptyState={
              <EmptyState
                icon={CalendarDays}
                title={t("adminLeave.rollover.rules.empty")}
                hint={t("adminLeave.rollover.rules.emptyHint")}
                action={
                  <Button asChild>
                    <Link to="/admin/leave/types">
                      {t("adminLeave.rollover.openTypes")}
                    </Link>
                  </Button>
                }
              />
            }
          />
        </StateBoundary>
      </section>

      <section>
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminLeave.rollover.history.heading")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("adminLeave.rollover.history.hint")}
        </p>
        <StateBoundary
          loading={runs.isLoading}
          error={runs.error ?? undefined}
          onRetry={() => void runs.refetch()}
          partialError={types.error ?? undefined}
          partialLabel={t("adminLeave.rollover.partialTypes")}
          skeletonRows={3}
        >
          <DataGrid
            columns={runColumns}
            rows={runs.data ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            emptyState={
              <EmptyState
                icon={Cog}
                title={t("adminLeave.rollover.history.empty")}
                hint={t("adminLeave.rollover.history.emptyHint")}
              />
            }
          />
        </StateBoundary>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        {t("adminLeave.rollover.footnote")}
      </p>
    </div>
  );
}
