/**
 * §8 · /admin/payroll/bank-advice — the payment file for the bank, and the
 * payslips inside it.
 *
 * RECON: `bank_advice_batches` IS deployed (migration 022 §6) with
 * `total_amount_paise`, `record_count`, `checksum`, `value_date`, `bank_reference`
 * and a `downloaded_by` / `downloaded_at` pair, and `payslips.payment_status`
 * carries `in_batch` with `payslips.bank_advice_batch_id` pointing back at the
 * batch. That is exactly the pair this screen reconciles:
 *
 *     the batch says   record_count and total_amount_paise
 *     the payslips say which people and which net amounts are in it
 *
 * Both numbers are SERVER columns, printed side by side. The client does not add
 * up the payslip rows to check the batch total — that comparison is the exporting
 * job's responsibility (it wrote the checksum), and re-deriving it in a browser
 * page would only produce a second, unauthoritative figure. The batch's own
 * `record_count` and the `count=exact` of payslips carrying that
 * `bank_advice_batch_id` are shown as what they are: two independent server facts
 * an operator can read against each other.
 *
 * NO GENERATE AND NO DOWNLOAD BUTTON, deliberately: `payslips` grants SELECT only
 * to `authenticated`, `bank_advice_batches` is written by the exporting job, and
 * no bank-advice edge function is deployed (the deployed list has payroll-run and
 * payslip-publish, nothing that emits a bank file). The table comment says every
 * download must be logged in `export_log` by that function — so offering a
 * client-side download here would produce an unlogged export of every bank account
 * in the company. The gap is stated instead.
 *
 * @route /admin/payroll/bank-advice
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Banknote, FileSpreadsheet } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { CountTile } from "../components/CountTile";
import { PAYROLL_RUN_CHIP } from "../display";
import { useAdminPayrollRuns } from "../hooks/useAdminPayroll";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useBankAdviceBatchCount,
  useBankAdviceBatches,
  usePayslipPaymentCount,
  usePayslipPayments,
} from "../hooks/usePayrollStatutory";
import {
  REGISTER_ROW_CAP,
  type BankAdviceBatch,
  type PayslipPayment,
} from "../api/payroll-statutory.api";
import type { PayrollRun } from "../api/payroll.api";

/** `ck_bab__status` — the seven deployed batch states, in HR's words. */
const BATCH_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.advice.state.draft"), tone: "neutral" },
  generated: { label: t("admin.advice.state.generated"), tone: "info" },
  downloaded: { label: t("admin.advice.state.downloaded"), tone: "info" },
  uploaded_to_bank: { label: t("admin.advice.state.uploaded"), tone: "warn" },
  acknowledged: { label: t("admin.advice.state.acknowledged"), tone: "success" },
  partially_failed: { label: t("admin.advice.state.partiallyFailed"), tone: "danger" },
  completed: { label: t("admin.advice.state.completed"), tone: "success" },
};

/** `ck_payslips__payment_status`. */
const PAYMENT_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.advice.pay.pending"), tone: "warn" },
  in_batch: { label: t("admin.advice.pay.inBatch"), tone: "info" },
  paid: { label: t("admin.advice.pay.paid"), tone: "success" },
  failed: { label: t("admin.advice.pay.failed"), tone: "danger" },
  held: { label: t("admin.advice.pay.held"), tone: "warn" },
  reversed: { label: t("admin.advice.pay.reversed"), tone: "neutral" },
};

/** `ck_bab__format` — the five file formats the exporter can emit. */
const FORMAT_LABEL: Readonly<Record<string, string>> = {
  icici_h2h: t("admin.advice.format.iciciH2h"),
  hdfc_neft: t("admin.advice.format.hdfcNeft"),
  sbi_ct: t("admin.advice.format.sbiCt"),
  npci_nach: t("admin.advice.format.npciNach"),
  generic_csv: t("admin.advice.format.genericCsv"),
};

function runOptions(runs: readonly PayrollRun[] | undefined): SelectOption[] {
  return (runs ?? []).map((run) => ({
    value: run.id,
    label: `${run.run_number} · ${PAYROLL_RUN_CHIP[run.status].label}`,
  }));
}

export default function PayrollBankAdvicePage() {
  const [params, setParams] = useSearchParams();
  const runs = useAdminPayrollRuns(null);
  const runParam = params.get("run") ?? "";
  const runId = runParam === "" ? null : runParam;
  const batchParam = params.get("batch") ?? "";
  const batchId = batchParam === "" ? null : batchParam;

  const batches = useBankAdviceBatches(runId);
  const batchRows = useMemo(() => batches.data ?? [], [batches.data]);
  const batchCount = useBankAdviceBatchCount(runId);

  const inBatchCount = usePayslipPaymentCount({ runId, paymentStatus: "in_batch" });
  const unbatchedCount = usePayslipPaymentCount({ runId, unbatched: true });
  const paidCount = usePayslipPaymentCount({ runId, paymentStatus: "paid" });

  // The chosen batch's contents, and the count of the SAME predicate beside the
  // batch's own record_count — two server facts, not one derived from the other.
  const members = usePayslipPayments({ batchId }, batchId !== null);
  const memberCount = usePayslipPaymentCount({ batchId }, batchId !== null);
  const labels = useEmployeeLabels();
  const labelMap = labels.data;

  const selectedBatch = useMemo(
    () => batchRows.find((row) => row.id === batchId) ?? null,
    [batchRows, batchId],
  );

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "run") next.delete("batch");
    setParams(next, { replace: true });
  };

  const batchColumns: DataGridColumn<BankAdviceBatch>[] = useMemo(
    () => [
      {
        key: "batch_number",
        header: t("admin.advice.col.batch"),
        width: "13rem",
        sortable: true,
        render: (row) => <span className="num font-medium">{row.batch_number}</span>,
      },
      {
        key: "bank_name",
        header: t("admin.advice.col.bank"),
        width: "12rem",
        render: (row) => <span>{dash(row.bank_name)}</span>,
      },
      {
        key: "format",
        header: t("admin.advice.col.format"),
        width: "12rem",
        hideBelow: "md",
        render: (row) => <span>{FORMAT_LABEL[row.format] ?? dash(row.format)}</span>,
      },
      {
        key: "value_date",
        header: t("admin.advice.col.valueDate"),
        width: "11rem",
        hideBelow: "md",
        render: (row) => dash(row.value_date, fmtCivilDate),
      },
      {
        key: "record_count",
        header: t("admin.advice.col.records"),
        width: "9rem",
        align: "right",
        render: (row) => <span className="num">{formatNumber(row.record_count)}</span>,
      },
      {
        key: "total_amount_paise",
        header: t("admin.advice.col.total"),
        width: "12rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_amount_paise} className="font-semibold" />,
      },
      {
        key: "status",
        header: t("admin.advice.col.status"),
        width: "11rem",
        render: (row) => <StatusChip status={row.status} map={BATCH_CHIP} />,
      },
      {
        key: "checksum",
        header: t("admin.advice.col.checksum"),
        width: "14rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="num block max-w-[14rem] truncate text-xs text-muted-foreground">
            {dash(row.checksum)}
          </span>
        ),
      },
      {
        key: "downloaded_at",
        header: t("admin.advice.col.downloaded"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.downloaded_at, fmtDateTime),
      },
      {
        key: "bank_reference",
        header: t("admin.advice.col.reference"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => <span className="num text-xs">{dash(row.bank_reference)}</span>,
      },
    ],
    [],
  );

  const memberColumns: DataGridColumn<PayslipPayment>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.advice.col.employee"),
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
        key: "payslip_number",
        header: t("admin.advice.col.payslip"),
        width: "13rem",
        render: (row) => <span className="num">{row.payslip_number}</span>,
      },
      {
        key: "net_pay_paise",
        header: t("admin.advice.col.net"),
        width: "12rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.net_pay_paise} className="font-medium" />,
      },
      {
        key: "payment_status",
        header: t("admin.advice.col.paymentStatus"),
        width: "11rem",
        render: (row) => <StatusChip status={row.payment_status} map={PAYMENT_CHIP} />,
      },
      {
        key: "payment_reference",
        header: t("admin.advice.col.utr"),
        width: "13rem",
        hideBelow: "md",
        render: (row) => <span className="num text-xs">{dash(row.payment_reference)}</span>,
      },
      {
        key: "paid_on",
        header: t("admin.advice.col.paidOn"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => dash(row.paid_on, fmtCivilDate),
      },
      {
        key: "bank_account_id",
        header: t("admin.advice.col.account"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) =>
          row.bank_account_id === null ? (
            <span className="text-xs text-warning">{t("admin.advice.noAccount")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("admin.advice.accountOnFile")}</span>
          ),
      },
    ],
    [labelMap],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.advice.title")}
        subtitle={t("admin.advice.subtitle")}
      />

      <Notice tone="warning" className="mb-4">
        {t("admin.advice.gap.noExporter")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <SelectField
          label={t("admin.advice.filter.run")}
          value={runParam}
          options={runOptions(runs.data)}
          placeholder={t("admin.advice.filter.allRuns")}
          onChange={(value) => setParam("run", value)}
        />
        <div className="flex items-end">
          <p className="text-sm text-muted-foreground">
            {batchCount.isSuccess
              ? t("admin.advice.batchCount", { n: formatNumber(batchCount.data) })
              : t("admin.advice.batchCountUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <CountTile
          label={t("admin.advice.tile.inBatch")}
          hint={t("admin.advice.tile.inBatchHint")}
          to={`/admin/payroll/bank-advice${runId !== null ? `?run=${encodeURIComponent(runId)}` : ""}`}
          drillLabel={t("admin.advice.tile.inBatch")}
          source={t("admin.advice.source.payslips")}
          query={inBatchCount}
        />
        <CountTile
          label={t("admin.advice.tile.unbatched")}
          hint={t("admin.advice.tile.unbatchedHint")}
          to={`/admin/payroll/bank-advice${runId !== null ? `?run=${encodeURIComponent(runId)}` : ""}`}
          drillLabel={t("admin.advice.tile.unbatched")}
          source={t("admin.advice.source.payslips")}
          query={unbatchedCount}
        />
        <CountTile
          label={t("admin.advice.tile.paid")}
          hint={t("admin.advice.tile.paidHint")}
          to={`/admin/payroll/bank-advice${runId !== null ? `?run=${encodeURIComponent(runId)}` : ""}`}
          drillLabel={t("admin.advice.tile.paid")}
          source={t("admin.advice.source.payslips")}
          query={paidCount}
        />
      </div>

      <section className="mt-6">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("admin.advice.batches.title")}
        </h2>
        <StateBoundary
          loading={batches.isPending}
          error={batches.error}
          onRetry={() => void batches.refetch()}
          isEmpty={batchRows.length === 0}
          empty={
            <EmptyState
              icon={FileSpreadsheet}
              title={t("admin.advice.empty.title")}
              hint={runId !== null ? t("admin.advice.empty.filtered") : t("admin.advice.empty.hint")}
            />
          }
          skeletonRows={4}
        >
          <DataGrid
            columns={batchColumns}
            rows={batchRows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setParam("batch", row.id)}
          />
          {batchRows.length >= REGISTER_ROW_CAP ? (
            <div className="mt-3">
              <Notice tone="warning">
                {t("admin.common.rowCap", { count: formatNumber(REGISTER_ROW_CAP) })}
              </Notice>
            </div>
          ) : null}
        </StateBoundary>
      </section>

      {batchId !== null ? (
        <section className="mt-8">
          <h2 className="mb-2 font-display text-lg font-semibold">
            {t("admin.advice.members.title", {
              batch: selectedBatch?.batch_number ?? dash(null),
            })}
          </h2>
          <Notice tone="info" className="mb-3">
            {t("admin.advice.members.reconcile", {
              records: formatNumber(selectedBatch?.record_count ?? 0),
              counted: memberCount.isSuccess ? formatNumber(memberCount.data) : dash(null),
            })}
          </Notice>
          <StateBoundary
            loading={members.isPending}
            error={members.error}
            onRetry={() => void members.refetch()}
            partialError={labels.error}
            partialLabel={t("admin.common.partial.names")}
            isEmpty={(members.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={FileSpreadsheet}
                title={t("admin.advice.members.empty.title")}
                hint={t("admin.advice.members.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            <DataGrid
              columns={memberColumns}
              rows={members.data ?? []}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </section>
      ) : null}

      <div className="mt-6">
        <Notice tone="info">{t("admin.advice.footnote")}</Notice>
      </div>
    </div>
  );
}
