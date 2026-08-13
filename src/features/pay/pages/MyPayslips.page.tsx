/**
 * E-08 · `/me/payslips` — Salary & payslips.
 *
 * Three promises this screen keeps:
 *  1. **Published only.** The rows come from `payslips`, whose own RLS is
 *     `self AND payroll_run_is_released(...)` (migration 022). A draft run is
 *     not filtered out here — it was never in the result set. There is no
 *     client-side "published" predicate that a later refactor could drop.
 *  2. **Masked by default.** Every rupee on the page renders through `<Money>`
 *     with `masked` bound to one page-level session reveal, with the remaining
 *     time on screen. Nothing about the reveal is persisted.
 *  3. **No totals computed here.** The year-to-date tiles read the `ytd_*`
 *     columns payroll stamped on the latest published payslip of the year. This
 *     browser never adds up twelve payslips to get a YTD — that is exactly how a
 *     tile and its detail page end up disagreeing.
 *
 * @route /me/payslips
 */
import { useMemo, useState } from "react";
import { Banknote, ChevronRight, FileText } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtCivilMonth, istMonthOfDate } from "@/lib/datetime";
import { dash, formatDaysFixed } from "@/lib/format";
import { usePayslips } from "../hooks/usePay";
import { paymentStatusChipMap } from "../display";
import { useIdentityGate } from "../identity";
import { useAmountReveal } from "../reveal";
import { RevealNote, ShowAmounts } from "../components/ShowAmounts";
import type { PayslipSummary } from "../api/pay.api";

/** The month key of a payslip: its period code when present, else its start date. */
function periodKey(row: PayslipSummary): string {
  return row.pay_period?.code ?? istMonthOfDate(row.period_start);
}

export default function MyPayslipsPage() {
  const navigate = useNavigate();
  const reveal = useAmountReveal();
  const identity = useIdentityGate();
  const payslips = usePayslips();
  const masked = !reveal.revealed;
  const statusMap = useMemo(() => paymentStatusChipMap(), []);

  const rows = payslips.data ?? [];

  /** Financial years present in the data, newest first. Never derived from today. */
  const financialYears = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      const fy = row.pay_period?.financial_year;
      if (fy !== undefined && fy !== null) seen.add(fy);
    }
    return [...seen].sort((a, b) => b.localeCompare(a));
  }, [rows]);

  const [fyFilter, setFyFilter] = useState<string | null>(null);
  const activeFy = fyFilter ?? financialYears[0] ?? null;

  const visibleRows = useMemo(
    () =>
      activeFy === null
        ? rows
        : rows.filter((row) => (row.pay_period?.financial_year ?? null) === activeFy),
    [rows, activeFy],
  );

  /**
   * The newest published payslip of the selected year carries that year's
   * cumulative `ytd_*` totals. `rows` arrives ordered by `period_start` DESC, so
   * this is a pick, not a computation.
   */
  const latestOfYear = visibleRows[0];

  const columns: DataGridColumn<PayslipSummary>[] = [
    {
      key: "period",
      header: t("pay.list.col.period"),
      render: (row) => (
        <div>
          <p className="font-medium">{fmtCivilMonth(periodKey(row))}</p>
          <p className="text-xs text-muted-foreground">
            {t("pay.list.window", {
              from: fmtCivilDate(row.period_start),
              to: fmtCivilDate(row.period_end),
            })}
          </p>
        </div>
      ),
    },
    {
      key: "paid_days",
      header: t("pay.list.col.paidDays"),
      align: "right",
      render: (row) =>
        t("pay.list.paidDaysOf", {
          paid: formatDaysFixed(row.paid_days),
          total: row.period_days,
        }),
    },
    {
      key: "gross_earnings_paise",
      header: t("pay.list.col.gross"),
      align: "right",
      hideBelow: "md",
      render: (row) => <Money paise={row.gross_earnings_paise} masked={masked} />,
    },
    {
      key: "total_deductions_paise",
      header: t("pay.list.col.deductions"),
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.total_deductions_paise} masked={masked} />,
    },
    {
      key: "net_pay_paise",
      header: t("pay.list.col.net"),
      align: "right",
      render: (row) => (
        <span className="font-medium">
          <Money paise={row.net_pay_paise} masked={masked} />
        </span>
      ),
    },
    {
      key: "payment_status",
      header: t("pay.list.col.status"),
      render: (row) =>
        row.is_reversed ? (
          <StatusChip status="reversed" map={statusMap} />
        ) : (
          <StatusChip status={row.payment_status} map={statusMap} />
        ),
    },
    {
      key: "actions",
      header: t("pay.list.col.actions"),
      align: "right",
      render: (row) => (
        <span className="inline-flex items-center gap-3">
          <Link
            to={`/me/payslips/${periodKey(row)}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("pay.list.view")}
          </Link>
          {/*
            DOWNLOAD FROM THE LIST, not three clicks in.

            This was a link to `#pdf` on the payslip viewer — so getting a copy
            meant: open the payslip, scroll to the actions block, press "Get the
            PDF" to mint a link, then press the link. Four steps to do the thing
            people come to this screen for.

            `DocumentOpenButtons` is the same control every other document uses:
            it calls `document-access`, which records the access BEFORE the URL
            exists and returns a signed link that expires. Download is allowed
            here — unlike on the policy register — because a payslip is the
            employee's own record and keeping a copy is the point of it.
          */}
          {row.pdf_document_id !== null ? (
            <DocumentOpenButtons
              documentId={row.pdf_document_id}
              title={t("pay.list.pdf")}
              variant="text"
              allowDownload
            />
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Banknote}
        title={t("pay.payslips.title")}
        subtitle={t("pay.payslips.subtitle")}
        actions={<ShowAmounts reveal={reveal} />}
      />
      <RevealNote reveal={reveal} />

      {/* --------------------------------------------------- year-to-date tiles */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold">
            {activeFy === null
              ? t("pay.ytd.headingNoYear")
              : t("pay.ytd.heading", { fy: activeFy })}
          </h2>
          {financialYears.length > 1 ? (
            <div
              className="flex flex-wrap items-center gap-1"
              role="group"
              aria-label={t("pay.list.fy.label")}
            >
              {financialYears.map((fy) => (
                <Button
                  key={fy}
                  variant={fy === activeFy ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={fy === activeFy}
                  onClick={() => setFyFilter(fy)}
                >
                  {fy}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <StateBoundary
          loading={identity.resolving || payslips.isPending}
          error={identity.error ?? payslips.error}
          onRetry={() => void payslips.refetch()}
          isEmpty={latestOfYear === undefined}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={Banknote}
              title={t("pay.ytd.empty.title")}
              hint={t("pay.ytd.empty.hint")}
              action={
                <Link
                  to="/me/helpdesk"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t("pay.ytd.empty.action")}
                </Link>
              }
            />
          }
        >
          {latestOfYear !== undefined ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <YtdTile
                  label={t("pay.ytd.gross")}
                  paise={latestOfYear.ytd_gross_paise}
                  masked={masked}
                  asAt={fmtCivilMonth(periodKey(latestOfYear))}
                  fy={activeFy}
                  count={visibleRows.length}
                />
                <YtdTile
                  label={t("pay.ytd.deductions")}
                  paise={latestOfYear.ytd_deductions_paise}
                  masked={masked}
                  asAt={fmtCivilMonth(periodKey(latestOfYear))}
                  fy={activeFy}
                  count={visibleRows.length}
                />
                <YtdTile
                  label={t("pay.ytd.net")}
                  paise={latestOfYear.ytd_net_paise}
                  masked={masked}
                  asAt={fmtCivilMonth(periodKey(latestOfYear))}
                  fy={activeFy}
                  count={visibleRows.length}
                />
                <YtdTile
                  label={t("pay.ytd.tds")}
                  paise={latestOfYear.ytd_tds_paise}
                  masked={masked}
                  asAt={fmtCivilMonth(periodKey(latestOfYear))}
                  fy={activeFy}
                  count={visibleRows.length}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("pay.ytd.asAt", { period: fmtCivilMonth(periodKey(latestOfYear)) })}
              </p>
            </>
          ) : null}
        </StateBoundary>
      </section>

      {/* ------------------------------------------------------------ the list */}
      <section>
        <div className="mb-3">
          <h2 className="font-display text-lg font-semibold">{t("pay.list.heading")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("pay.list.note")}</p>
        </div>
        <StateBoundary
          loading={identity.resolving}
          error={identity.error ?? payslips.error}
          onRetry={() => void payslips.refetch()}
          skeletonRows={4}
        >
          <DataGrid
            columns={columns}
            rows={visibleRows}
            rowKey={(row) => row.id}
            loading={payslips.isPending}
            pageSize={12}
            onRowClick={(row) => navigate(`/me/payslips/${periodKey(row)}`)}
            emptyState={
              <EmptyState
                icon={Banknote}
                title={t("pay.list.empty.title")}
                hint={t("pay.list.empty.hint")}
                action={
                  financialYears.length > 1 && fyFilter !== null ? (
                    <Button variant="outline" size="sm" onClick={() => setFyFilter(null)}>
                      {t("pay.list.fy.all")}
                    </Button>
                  ) : (
                    <Link
                      to="/me/helpdesk"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t("pay.list.empty.action")}
                    </Link>
                  )
                }
              />
            }
          />
        </StateBoundary>
      </section>

      {/* ------------------------------------------------ structure cross-link */}
      <Link
        to="/me/profile/salary"
        className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-start gap-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block font-medium">{t("pay.payslips.structureLink")}</span>
            <span className="block text-sm text-muted-foreground">
              {t("pay.payslips.structureLink.hint")}
            </span>
          </span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </div>
  );
}

/**
 * One year-to-date tile. The explainer says, in words and with the reader's own
 * figures, that the number was READ off a payslip rather than added up here —
 * because "where did this come from" is the question a YTD total always raises.
 */
function YtdTile({
  label,
  paise,
  masked,
  asAt,
  fy,
  count,
}: {
  label: string;
  paise: number | null;
  masked: boolean;
  asAt: string;
  fy: string | null;
  count: number;
}) {
  return (
    <KpiTile
      label={label}
      value={<Money paise={paise} masked={masked} />}
      hint={t("pay.ytd.asAt", { period: asAt })}
      explainer={{
        formula: t("pay.ytd.formula"),
        numbers: t("pay.ytd.numbers", {
          fy: dash(fy),
          period: asAt,
          count,
        }),
      }}
    />
  );
}
