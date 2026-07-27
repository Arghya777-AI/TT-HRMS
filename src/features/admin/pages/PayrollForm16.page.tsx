/**
 * §8 · /admin/payroll/form16 — Form 16 Distribution.
 *
 * RECON: `form16_documents` IS deployed (migration 022 §7) — unique on
 * (employee, financial year, part), with `certificate_number`, `tan`,
 * `total_income_paise`, `total_tds_paise`, `issued_on`, `distributed_at`,
 * `acknowledged_at` and `traces_reference`, and admin INSERT/UPDATE policies. So
 * the register is real and this screen renders it.
 *
 * What does NOT exist is the GENERATION and BULK-ISSUE path the manifest hint
 * asks for: no `form16` edge function is deployed (the function list is
 * payroll-run, payslip-publish, document-generate, … and none of them takes a
 * financial year), no RPC assembles Part A/Part B from `payslips.ytd_tds_paise`,
 * and no job writes `distributed_at`. Issuing a Form 16 also means signing and
 * filing a TRACES certificate — inventing a "Generate" button that only wrote a
 * row would produce a certificate number for a document that does not exist.
 * So there is no write on this screen, and the gap is stated where an admin looks
 * for the button rather than buried in a tooltip.
 *
 * The delivery state is read off the columns that are evidence: a Form 16 is
 * "issued" when `issued_on` is set, "distributed" when `distributed_at` is, and
 * "acknowledged" only when the employee's own acknowledgement stamped
 * `acknowledged_at`. Money is integer paise via `<Money>`.
 *
 * @route /admin/payroll/form16
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
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
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useForm16Count,
  useForm16Documents,
  useForm16YearOptions,
} from "../hooks/usePayrollStatutory";
import { REGISTER_ROW_CAP, type Form16Document } from "../api/payroll-statutory.api";

/** `ck_f16__part` — A, B or a consolidated certificate. */
const PART_OPTIONS = [
  { value: "A", label: t("admin.f16.part.a") },
  { value: "B", label: t("admin.f16.part.b") },
  { value: "consolidated", label: t("admin.f16.part.consolidated") },
] as const;

/**
 * Delivery state read from the three evidence columns, in the order that makes a
 * later stamp win. This is a LABEL for columns that are already set, not a status
 * this screen decides: nothing is written back, and no date is compared to now().
 */
const DELIVERY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  acknowledged: { label: t("admin.f16.state.acknowledged"), tone: "success" },
  distributed: { label: t("admin.f16.state.distributed"), tone: "info" },
  issued: { label: t("admin.f16.state.issued"), tone: "warn" },
  prepared: { label: t("admin.f16.state.prepared"), tone: "neutral" },
};

function deliveryState(row: Form16Document): string {
  if (row.acknowledged_at !== null) return "acknowledged";
  if (row.distributed_at !== null) return "distributed";
  if (row.issued_on !== null) return "issued";
  return "prepared";
}

export default function PayrollForm16Page() {
  const [params, setParams] = useSearchParams();
  const financialYear = params.get("fy") ?? "";
  const part = params.get("part") ?? "";

  const filters = useMemo(
    () => ({ financialYear: financialYear === "" ? null : financialYear, part: part === "" ? null : part }),
    [financialYear, part],
  );

  // Unfiltered read first: it is what the year picker can honestly offer.
  const all = useForm16Documents({});
  const documents = useForm16Documents(filters);
  const rows = useMemo(() => documents.data ?? [], [documents.data]);
  const matching = useForm16Count(filters);
  const years = useForm16YearOptions(all.data);
  const labels = useEmployeeLabels();
  const labelMap = labels.data;

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const columns: DataGridColumn<Form16Document>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.f16.col.employee"),
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
        key: "financial_year",
        header: t("admin.f16.col.fy"),
        width: "8rem",
        sortable: true,
        render: (row) => <span className="num">{row.financial_year}</span>,
      },
      {
        key: "part",
        header: t("admin.f16.col.part"),
        width: "9rem",
        render: (row) => (
          <span>
            {PART_OPTIONS.find((option) => option.value === row.part)?.label ?? dash(row.part)}
          </span>
        ),
      },
      {
        key: "certificate_number",
        header: t("admin.f16.col.certificate"),
        width: "13rem",
        hideBelow: "md",
        render: (row) => <span className="num text-xs">{dash(row.certificate_number)}</span>,
      },
      {
        key: "tan",
        header: t("admin.f16.col.tan"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => <span className="num text-xs">{dash(row.tan)}</span>,
      },
      {
        key: "total_income_paise",
        header: t("admin.f16.col.income"),
        width: "11rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <Money paise={row.total_income_paise} />,
      },
      {
        key: "total_tds_paise",
        header: t("admin.f16.col.tds"),
        width: "11rem",
        align: "right",
        render: (row) => <Money paise={row.total_tds_paise} className="font-medium" />,
      },
      {
        key: "state",
        header: t("admin.f16.col.state"),
        width: "11rem",
        render: (row) => <StatusChip status={deliveryState(row)} map={DELIVERY_CHIP} />,
      },
      {
        key: "issued_on",
        header: t("admin.f16.col.issued"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => dash(row.issued_on, fmtCivilDate),
      },
      {
        key: "distributed_at",
        header: t("admin.f16.col.distributed"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.distributed_at, fmtDateTime),
      },
      {
        key: "acknowledged_at",
        header: t("admin.f16.col.acknowledged"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => dash(row.acknowledged_at, fmtDateTime),
      },
      {
        key: "traces_reference",
        header: t("admin.f16.col.traces"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => <span className="num text-xs">{dash(row.traces_reference)}</span>,
      },
    ],
    [labelMap],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileText}
        title={t("admin.f16.title")}
        subtitle={t("admin.f16.subtitle")}
      />

      <Notice tone="warning" className="mb-4">
        {t("admin.f16.gap.noGenerator")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.f16.filter.fy")}
          value={financialYear}
          options={years.map((year) => ({ value: year, label: year }))}
          placeholder={t("admin.f16.filter.allYears")}
          {...(years.length === 0 ? { hint: t("admin.f16.filter.noYears") } : {})}
          onChange={(value) => setParam("fy", value)}
        />
        <SelectField
          label={t("admin.f16.filter.part")}
          value={part}
          options={PART_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          placeholder={t("admin.f16.filter.allParts")}
          onChange={(value) => setParam("part", value)}
        />
        <div className="flex items-end">
          <p className="text-sm text-muted-foreground">
            {matching.isSuccess
              ? t("admin.f16.matching", { n: formatNumber(matching.data) })
              : t("admin.f16.matchingUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={documents.isPending}
          error={documents.error}
          onRetry={() => void documents.refetch()}
          partialError={labels.error ?? all.error}
          partialLabel={t("admin.common.partial.names")}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={FileText}
              title={t("admin.f16.empty.title")}
              hint={
                financialYear !== "" || part !== ""
                  ? t("admin.f16.empty.filtered")
                  : t("admin.f16.empty.hint")
              }
            />
          }
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
          {rows.length >= REGISTER_ROW_CAP ? (
            <div className="mt-3">
              <Notice tone="warning">
                {t("admin.common.rowCap", { count: formatNumber(REGISTER_ROW_CAP) })}
              </Notice>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-6">
        <Notice tone="info">{t("admin.f16.footnote")}</Notice>
      </div>
    </div>
  );
}
