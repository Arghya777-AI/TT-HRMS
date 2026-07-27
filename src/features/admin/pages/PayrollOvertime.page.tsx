/**
 * §8 · /admin/payroll/overtime — Overtime & Incentives. What the engine measured,
 * what carries an approval, and what payroll actually paid — for one pay period.
 *
 * RECON, and the honest consequence of it: there is NO `overtime_preapprovals`
 * table. The name appears twice in the deployed schema — in the
 * `request_types.entity_table` whitelist (migration 029) and as the seeded
 * `OT_PREAPPROVAL` request type (migration 045) — and no migration ever creates
 * it. So this screen cannot offer "approve this OT", and it does not pretend to:
 * it is a REGISTER built from the three things that ARE deployed and are the
 * server's own numbers.
 *
 *   1. `v_attendance_monthly_summary` (over `analytics.mv_attendance_monthly`) —
 *      `overtime_minutes` is what the attendance engine computed after the OT
 *      policy's minimum, rounding and daily cap; `approved_overtime_minutes` is
 *      the subset stamped as approved, and `payslips.overtime_minutes` is
 *      documented as "approved only". Both are SUMs computed by Postgres. The
 *      screen prints them in adjacent columns and never subtracts one from the
 *      other — a client-side "unapproved OT" figure would be payroll arithmetic in
 *      the browser, and PostgREST cannot compare two columns server-side either.
 *   2. `OT` / `NIGHT_ALLOW` payslip lines for the period — the money, in integer
 *      paise, each with the `calc_basis` the engine recorded (multiplier, hours,
 *      basic). Money appears only once a run has computed, which is why an empty
 *      money table beside a populated minutes table is a state, not a bug.
 *   3. The OT pre-approval queue routed to the signed-in approver
 *      (`v_approval_inbox`). Real view, real request type, and necessarily empty
 *      while the detail table is missing — which the empty state says outright.
 *
 * Durations are `fmtDurationHm` (never a decimal-hours guess), money is `<Money>`,
 * and every tile is a `count=exact` sharing its grid's filter array.
 *
 * @route /admin/payroll/overtime
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Clock, Timer } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { fmtCivilDate, fmtDateTime, fmtDurationHm } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { CountTile } from "../components/CountTile";
import { useAdminPayPeriods } from "../hooks/useAdminPayroll";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useOvertimeCount,
  useOvertimePreapprovalInbox,
  useOvertimeRegister,
  usePremiumLines,
} from "../hooks/usePayrollStatutory";
import {
  REGISTER_ROW_CAP,
  isOvertimeSlice,
  type OvertimeMonthRow,
  type OvertimeSlice,
} from "../api/payroll-statutory.api";
import type { PayPeriod, PayslipLine } from "../api/payroll.api";

const SLICE_TILES: readonly { slice: OvertimeSlice; label: string; hint: string }[] = [
  { slice: "any", label: t("admin.ot.tile.any"), hint: t("admin.ot.tile.anyHint") },
  {
    slice: "approved",
    label: t("admin.ot.tile.approved"),
    hint: t("admin.ot.tile.approvedHint"),
  },
  {
    slice: "extraWork",
    label: t("admin.ot.tile.extra"),
    hint: t("admin.ot.tile.extraHint"),
  },
];

function periodOptions(periods: readonly PayPeriod[] | undefined): SelectOption[] {
  return (periods ?? []).map((period) => ({
    value: period.id,
    label: `${period.name} · ${t("admin.common.dateRange", {
      from: fmtCivilDate(period.start_date),
      to: fmtCivilDate(period.end_date),
    })}`,
  }));
}

export default function PayrollOvertimePage() {
  const [params, setParams] = useSearchParams();
  const periods = useAdminPayPeriods();

  const sliceParam = params.get("slice");
  const slice: OvertimeSlice | null = isOvertimeSlice(sliceParam) ? sliceParam : null;

  // `fetchPayPeriods` orders start_date DESC, so the head of the list is the
  // latest period the admin can see. It is a CHOICE of default, not a derived
  // figure — the period itself is a server row.
  const firstPeriodId = periods.data?.[0]?.id ?? "";
  const periodId = params.get("period") ?? firstPeriodId;

  const register = useOvertimeRegister(periodId, slice);
  const rows = useMemo(() => register.data ?? [], [register.data]);
  const labels = useEmployeeLabels();
  const premium = usePremiumLines(periodId);
  const inbox = useOvertimePreapprovalInbox();

  const counts: Record<OvertimeSlice, ReturnType<typeof useOvertimeCount>> = {
    any: useOvertimeCount(periodId, "any"),
    approved: useOvertimeCount(periodId, "approved"),
    extraWork: useOvertimeCount(periodId, "extraWork"),
  };

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const labelMap = labels.data;

  // The matview's own stamp — a period summary that hides its age is worse than
  // one that admits it.
  const asOf = rows[0]?.refreshed_at ?? null;

  const columns: DataGridColumn<OvertimeMonthRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.ot.col.employee"),
        width: "16rem",
        render: (row) => {
          const who = labelMap?.get(row.employee_id);
          return (
            <PersonCell
              name={who?.name ?? null}
              code={who?.code ?? null}
              secondary={who?.department ?? null}
            />
          );
        },
      },
      {
        key: "overtime_minutes",
        header: t("admin.ot.col.computed"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{fmtDurationHm(row.overtime_minutes)}</span>,
      },
      {
        key: "approved_overtime_minutes",
        header: t("admin.ot.col.approved"),
        width: "9rem",
        align: "right",
        sortable: true,
        render: (row) => (
          <span className="num font-medium">{fmtDurationHm(row.approved_overtime_minutes)}</span>
        ),
      },
      {
        key: "extra_work_minutes",
        header: t("admin.ot.col.extra"),
        width: "9rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <span className="num">{fmtDurationHm(row.extra_work_minutes)}</span>,
      },
      {
        key: "present_days",
        header: t("admin.ot.col.presentDays"),
        width: "8rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.present_days)}</span>,
      },
      {
        key: "total_worked_minutes",
        header: t("admin.ot.col.worked"),
        width: "9rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <span className="num">{fmtDurationHm(row.total_worked_minutes)}</span>,
      },
    ],
    [labelMap],
  );

  const premiumColumns: DataGridColumn<PayslipLine>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.ot.col.employee"),
        width: "16rem",
        render: (row) => (
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.department_name}
          />
        ),
      },
      {
        key: "label",
        header: t("admin.ot.col.premium"),
        width: "12rem",
        render: (row) => <span>{dash(row.label)}</span>,
      },
      {
        key: "run_number",
        header: t("admin.ot.col.run"),
        width: "11rem",
        hideBelow: "md",
        render: (row) => <span className="num">{row.run_number}</span>,
      },
      {
        key: "overtime_minutes",
        header: t("admin.ot.col.paidMinutes"),
        width: "9rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <span className="num">{fmtDurationHm(row.overtime_minutes)}</span>,
      },
      {
        key: "amount_paise",
        header: t("admin.ot.col.amount"),
        width: "11rem",
        align: "right",
        render: (row) => <Money paise={row.amount_paise} className="font-medium" />,
      },
      {
        key: "ytd_amount_paise",
        header: t("admin.ot.col.ytd"),
        width: "11rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.ytd_amount_paise} />,
      },
    ],
    [],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Clock}
        title={t("admin.ot.title")}
        subtitle={t("admin.ot.subtitle")}
      />

      <Notice tone="warning" className="mb-4">
        {t("admin.ot.gap.preapproval")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <SelectField
          label={t("admin.ot.filter.period")}
          value={periodId}
          options={periodOptions(periods.data)}
          placeholder={t("admin.ot.filter.choosePeriod")}
          onChange={(value) => setParam("period", value)}
        />
        <SelectField
          label={t("admin.ot.filter.slice")}
          value={slice ?? ""}
          options={SLICE_TILES.map((tile) => ({ value: tile.slice, label: tile.label }))}
          placeholder={t("admin.ot.filter.everyone")}
          onChange={(value) => setParam("slice", value)}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {SLICE_TILES.map((tile) => (
          <CountTile
            key={tile.slice}
            label={tile.label}
            hint={tile.hint}
            to={`/admin/payroll/overtime?period=${encodeURIComponent(periodId)}&slice=${tile.slice}`}
            drillLabel={tile.label}
            source={t("admin.ot.source.register")}
            query={counts[tile.slice]}
          />
        ))}
      </div>

      {asOf !== null ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("admin.ot.asOf", { at: fmtDateTime(asOf) })}
        </p>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 font-display text-lg font-semibold">{t("admin.ot.minutes.title")}</h2>
        <StateBoundary
          loading={register.isPending && periodId !== ""}
          error={register.error}
          onRetry={() => void register.refetch()}
          partialError={labels.error}
          partialLabel={t("admin.common.partial.names")}
          isEmpty={periodId !== "" && rows.length === 0}
          empty={
            <EmptyState
              icon={Timer}
              title={t("admin.ot.empty.title")}
              hint={slice !== null ? t("admin.ot.empty.filtered") : t("admin.ot.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          {periodId === "" ? (
            <EmptyState
              icon={Timer}
              title={t("admin.ot.noPeriod.title")}
              hint={t("admin.ot.noPeriod.hint")}
            />
          ) : (
            <>
              <DataGrid
                columns={columns}
                rows={rows}
                rowKey={(row) => `${row.employee_id}:${row.pay_period_id}`}
                pageSize={25}
              />
              {rows.length >= REGISTER_ROW_CAP ? (
                <div className="mt-3">
                  <Notice tone="warning">
                    {t("admin.common.rowCap", { count: formatNumber(REGISTER_ROW_CAP) })}
                  </Notice>
                </div>
              ) : null}
            </>
          )}
        </StateBoundary>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-display text-lg font-semibold">{t("admin.ot.money.title")}</h2>
        <p className="mb-2 text-sm text-muted-foreground">{t("admin.ot.money.hint")}</p>
        <StateBoundary
          loading={premium.isPending && periodId !== ""}
          error={premium.error}
          onRetry={() => void premium.refetch()}
          isEmpty={periodId !== "" && (premium.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={Timer}
              title={t("admin.ot.money.empty.title")}
              hint={t("admin.ot.money.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={premiumColumns}
            rows={premium.data ?? []}
            rowKey={(row) => row.line_id ?? row.payslip_id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-display text-lg font-semibold">{t("admin.ot.queue.title")}</h2>
        <StateBoundary
          loading={inbox.isPending}
          error={inbox.error}
          onRetry={() => void inbox.refetch()}
          isEmpty={(inbox.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={Timer}
              title={t("admin.ot.queue.empty.title")}
              hint={t("admin.ot.queue.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <ul className="space-y-2">
            {(inbox.data ?? []).map((row) => (
              <li key={row.approval_request_id} className="rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <PersonCell
                    name={row.subject_display_name}
                    code={row.subject_employee_code}
                    secondary={row.subject_department_name}
                  />
                  <span className="num text-xs text-muted-foreground">
                    {t("admin.ot.queue.raised", { at: fmtDateTime(row.submitted_at) })}
                  </span>
                </div>
                <p className="mt-1 text-sm">{row.title}</p>
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>
    </div>
  );
}
