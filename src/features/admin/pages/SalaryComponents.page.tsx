/**
 * §8 · /admin/payroll/components — the salary component master: earnings,
 * deductions and their formulas.
 *
 * This is a READ register, deliberately. The table is admin-writable under RLS
 * (020 §1), but its rows are the payroll engine's vocabulary — BASIC, HRA,
 * PF_EE, PT — seeded with the statutory flags the engine computes from, and the
 * statutory rows are super-admin-only (`is_system_managed`). An inline editor
 * over thirty engine-input columns is a different ceremony from a register grid,
 * so this screen shows the truth and does not offer a casual write path.
 *
 * The "Calculation" column prints exactly what is stored: a fixed amount is
 * `<Money>` (integer paise), a percentage is the server's `percentage` column
 * (already a percentage, never re-derived), a formula is shown verbatim.
 *
 * @route /admin/payroll/components
 */
import { useMemo, useState } from "react";
import { Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { SalaryComponent } from "../api/payroll.api";
import { Notice } from "../components/Notice";
import {
  CALC_KIND_LABELS,
  LINE_KIND_CHIP,
  useComponentMap,
  useSalaryComponents,
} from "../hooks/usePayrollMasters";

/** What is stored, printed as stored — no client re-derivation. */
function CalcCell({
  row,
  components,
}: {
  row: SalaryComponent;
  components: ReadonlyMap<string, SalaryComponent>;
}) {
  const kindLabel = CALC_KIND_LABELS[row.calc_kind] ?? row.calc_kind;
  let detail: React.ReactNode = null;
  if (row.calc_kind === "fixed" && row.fixed_amount_paise !== null) {
    detail = <Money paise={row.fixed_amount_paise} />;
  } else if (row.percentage !== null && row.calc_kind === "pct_of_component") {
    const base = row.base_component_id !== null ? components.get(row.base_component_id) : undefined;
    detail = (
      <span className="num">
        {t("admin.paycomp.calc.pctOf", {
          pct: formatPercent(row.percentage),
          base: base?.code ?? dash(null),
        })}
      </span>
    );
  } else if (row.percentage !== null) {
    detail = <span className="num">{formatPercent(row.percentage)}</span>;
  } else if (row.formula !== null) {
    detail = <code className="rounded bg-muted px-1 py-0.5 text-xs">{row.formula}</code>;
  }
  return (
    <span className="flex flex-col leading-tight">
      <span>{kindLabel}</span>
      {detail !== null ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

/** The statutory wage bases this component counts toward, as short tags. */
function wageFlags(row: SalaryComponent): string {
  const tags: string[] = [];
  if (row.is_pf_wage) tags.push(t("admin.paycomp.flag.pf"));
  if (row.is_esi_wage) tags.push(t("admin.paycomp.flag.esi"));
  if (row.is_pt_wage) tags.push(t("admin.paycomp.flag.pt"));
  if (row.is_lwf_wage) tags.push(t("admin.paycomp.flag.lwf"));
  if (row.is_gratuity_wage) tags.push(t("admin.paycomp.flag.gratuity"));
  return tags.join(" · ");
}

export default function SalaryComponentsPage() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const components = useSalaryComponents(includeInactive);
  const componentMap = useComponentMap(components.data);

  const columns: DataGridColumn<SalaryComponent>[] = useMemo(
    () => [
      {
        key: "code",
        header: t("admin.paycomp.col.code"),
        width: "8rem",
        sortable: true,
        render: (row) => <span className="num font-medium">{row.code}</span>,
      },
      {
        key: "name",
        header: t("admin.paycomp.col.name"),
        width: "14rem",
        sortable: true,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{row.name}</span>
            {row.is_system_managed ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.paycomp.systemManaged")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "line_kind",
        header: t("admin.paycomp.col.kind"),
        width: "11rem",
        render: (row) => <StatusChip status={row.line_kind} map={LINE_KIND_CHIP} />,
      },
      {
        key: "calc_kind",
        header: t("admin.paycomp.col.calc"),
        width: "13rem",
        render: (row) => <CalcCell row={row} components={componentMap} />,
      },
      {
        key: "wage_flags",
        header: t("admin.paycomp.col.statutory"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) => {
          const flags = wageFlags(row);
          return flags === "" ? dash(null) : <span className="text-xs">{flags}</span>;
        },
      },
      {
        key: "is_taxable",
        header: t("admin.paycomp.col.taxable"),
        width: "6rem",
        align: "center",
        hideBelow: "md",
        render: (row) => (row.is_taxable ? t("common.yes") : t("common.no")),
      },
      {
        key: "prorate_on_paid_days",
        header: t("admin.paycomp.col.prorated"),
        width: "7rem",
        align: "center",
        hideBelow: "lg",
        render: (row) =>
          row.prorate_on_paid_days ? t("common.yes") : t("common.no"),
      },
      {
        key: "ctc_bucket",
        header: t("admin.paycomp.col.bucket"),
        width: "6rem",
        align: "center",
        hideBelow: "lg",
        render: (row) => <span className="num">{dash(row.ctc_bucket)}</span>,
      },
      {
        key: "sort_order",
        header: t("admin.paycomp.col.order"),
        width: "6rem",
        align: "right",
        hideBelow: "lg",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.sort_order)}</span>,
      },
      {
        key: "is_active",
        header: t("admin.paycomp.col.active"),
        width: "7rem",
        render: (row) => (
          <StatusChip
            status={row.is_active ? "active" : "inactive"}
            map={{
              active: { label: t("admin.paycomp.active"), tone: "success" },
              inactive: { label: t("admin.paycomp.inactive"), tone: "neutral" },
            }}
          />
        ),
      },
    ],
    [componentMap],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.paycomp.title")}
        subtitle={t("admin.paycomp.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.paycomp.readOnly")}
      </Notice>

      <StateBoundary
        loading={components.isPending}
        error={components.error}
        onRetry={() => void components.refetch()}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={components.data ?? []}
          rowKey={(row) => row.id}
          pageSize={50}
          toolbar={
            <Button
              type="button"
              variant={includeInactive ? "default" : "outline"}
              size="sm"
              onClick={() => setIncludeInactive((v) => !v)}
              aria-pressed={includeInactive}
            >
              {t("admin.paycomp.filter.includeInactive")}
            </Button>
          }
          emptyState={
            <EmptyState
              icon={Banknote}
              title={t("admin.paycomp.empty.title")}
              hint={t("admin.paycomp.empty.hint")}
            />
          }
        />
      </StateBoundary>
    </div>
  );
}
