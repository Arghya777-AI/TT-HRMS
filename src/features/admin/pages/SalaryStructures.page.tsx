/**
 * §8 · /admin/payroll/structures — the reusable salary structures and, for the
 * one you pick, the component lines the engine evaluates in order.
 *
 * Why it reads rather than edits. `salary_structures` and
 * `salary_structure_components` are admin-writable under RLS (020 §2/§3), but a
 * structure is a computation: `sequence` is evaluation order, a `balance`
 * component must evaluate LAST, and an override silently changes what every
 * employee on that structure is paid next month. That ceremony belongs with the
 * revision workflow, not to an inline cell editor in a master grid, so this
 * screen shows exactly what is stored and says so.
 *
 * Two honesty rules held here:
 *  1. A line prints its OWN override when it has one and the component's stored
 *     default otherwise, and the two are visually distinguished — an override of
 *     40% shown as if it were the component's own rate is how a structure ends up
 *     being audited against the wrong number.
 *  2. Nothing is summed. A structure has no total: the amounts it produces depend
 *     on the employee's gross, and those totals live on
 *     `v_employee_current_salary`, which the Employee Compensation screen reads.
 *
 * @route /admin/payroll/structures
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Banknote, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  EMPLOYMENT_TYPE_LABELS,
  employmentTypeValues,
} from "../api/employees.api";
import type { SalaryStructure, StructureLine } from "../api/payroll-masters.api";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import {
  LINE_KIND_CHIP,
  STRUCTURE_KIND_LABELS,
  calcKindLabel,
  useComponentMap,
  useSalaryComponents,
  useSalaryStructures,
  useStructureLines,
} from "../hooks/usePayrollMasters";

const ACTIVE_CHIP = {
  active: { label: t("admin.paycomp.active"), tone: "success" as const },
  inactive: { label: t("admin.paycomp.inactive"), tone: "neutral" as const },
};

/** `public.employment_type` — resolved without a cast, so an unknown value shows raw. */
function employmentTypeLabel(value: string): string {
  const known = employmentTypeValues.find((candidate) => candidate === value);
  return known === undefined ? value : EMPLOYMENT_TYPE_LABELS[known];
}

export default function SalaryStructuresPage() {
  const [params, setParams] = useSearchParams();

  const kindFilter = params.get("kind") ?? "";
  const includeInactive = params.get("inactive") === "1";
  const selectedId = params.get("structure");

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const structures = useSalaryStructures(includeInactive);
  // Include inactive components: a structure line can legitimately point at a
  // component that has since been switched off, and printing '—' for its name
  // would make the line look corrupt.
  const components = useSalaryComponents(true);
  const componentMap = useComponentMap(components.data);
  const grades = useRefOptions("grades");
  const lines = useStructureLines(selectedId);

  const gradeNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const grade of grades.data ?? []) map.set(grade.id, grade.name);
    return map;
  }, [grades.data]);

  const rows = useMemo(() => {
    const all = structures.data ?? [];
    return kindFilter === "" ? all : all.filter((row) => row.structure_kind === kindFilter);
  }, [structures.data, kindFilter]);

  const selected = useMemo(
    () => (structures.data ?? []).find((row) => row.id === selectedId) ?? null,
    [structures.data, selectedId],
  );

  // Built inline (as the Directory does): these cells close over the current
  // URLSearchParams, and memoising them would need `params` as a dependency
  // anyway.
  const structureColumns: DataGridColumn<SalaryStructure>[] = [
    {
      key: "code",
      header: t("admin.struct.col.code"),
      width: "9rem",
      sortable: true,
      render: (row) => <span className="num font-medium">{row.code}</span>,
    },
    {
      key: "name",
      header: t("admin.struct.col.name"),
      width: "16rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span>{row.name}</span>
          {row.description !== null ? (
            <span className="text-xs text-muted-foreground">{row.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "structure_kind",
      header: t("admin.struct.col.kind"),
      width: "10rem",
      render: (row) => dash(STRUCTURE_KIND_LABELS[row.structure_kind] ?? row.structure_kind),
    },
    {
      key: "applies_to",
      header: t("admin.struct.col.appliesTo"),
      width: "14rem",
      hideBelow: "lg",
      render: (row) => {
        const gradeLabels = (row.applies_to_grade_ids ?? []).map(
          (id) => gradeNames.get(id) ?? t("admin.struct.unknownGrade"),
        );
        const typeLabels = (row.applies_to_employment_types ?? []).map(employmentTypeLabel);
        const all = [...gradeLabels, ...typeLabels];
        return all.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("admin.struct.appliesToAny")}</span>
        ) : (
          <span className="text-xs">{all.join(" · ")}</span>
        );
      },
    },
    {
      key: "effective_from",
      header: t("admin.struct.col.effective"),
      width: "13rem",
      sortable: true,
      render: (row) => (
        <span className="num text-xs">
          {row.effective_to === null
            ? t("admin.struct.effectiveOpen", { from: fmtCivilDate(row.effective_from) })
            : t("admin.common.dateRange", {
                from: fmtCivilDate(row.effective_from),
                to: fmtCivilDate(row.effective_to),
              })}
        </span>
      ),
    },
    {
      key: "version",
      header: t("admin.struct.col.version"),
      width: "6rem",
      align: "right",
      hideBelow: "md",
      sortable: true,
      render: (row) => <span className="num">{formatNumber(row.version)}</span>,
    },
    {
      key: "is_template",
      header: t("admin.struct.col.template"),
      width: "7rem",
      align: "center",
      hideBelow: "lg",
      render: (row) => (row.is_template ? t("common.yes") : t("common.no")),
    },
    {
      key: "is_active",
      header: t("admin.struct.col.active"),
      width: "7rem",
      render: (row) => (
        <StatusChip status={row.is_active ? "active" : "inactive"} map={ACTIVE_CHIP} />
      ),
    },
    {
      key: "open",
      header: t("admin.struct.col.lines"),
      width: "8rem",
      align: "right",
      render: (row) => (
        <Button
          type="button"
          size="sm"
          variant={row.id === selectedId ? "default" : "outline"}
          onClick={(event) => {
            event.stopPropagation();
            setParam("structure", row.id);
          }}
        >
          {t("admin.struct.viewLines")}
        </Button>
      ),
    },
  ];

  const lineColumns: DataGridColumn<StructureLine>[] = useMemo(
    () => [
      {
        key: "sequence",
        header: t("admin.struct.line.sequence"),
        width: "7rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.sequence)}</span>,
      },
      {
        key: "component",
        header: t("admin.struct.line.component"),
        width: "18rem",
        render: (row) => {
          const component = componentMap.get(row.salary_component_id);
          if (component === undefined) {
            return (
              <span className="flex flex-col leading-tight">
                <span>{t("admin.struct.line.unknownComponent")}</span>
                <span className="text-xs text-muted-foreground">
                  {t("admin.struct.line.unknownComponentHint")}
                </span>
              </span>
            );
          }
          return (
            <span className="flex flex-col leading-tight">
              <span className="num font-medium">{component.code}</span>
              <span className="text-xs text-muted-foreground">{component.name}</span>
            </span>
          );
        },
      },
      {
        key: "line_kind",
        header: t("admin.struct.line.kind"),
        width: "11rem",
        render: (row) => {
          const component = componentMap.get(row.salary_component_id);
          return component === undefined ? (
            dash(null)
          ) : (
            <StatusChip status={component.line_kind} map={LINE_KIND_CHIP} />
          );
        },
      },
      {
        key: "calc",
        header: t("admin.struct.line.calc"),
        width: "14rem",
        render: (row) => {
          const component = componentMap.get(row.salary_component_id);
          const overridden = row.calc_kind_override !== null;
          const kind = row.calc_kind_override ?? component?.calc_kind ?? null;
          return (
            <span className="flex flex-col leading-tight">
              <span>{kind === null ? dash(null) : calcKindLabel(kind)}</span>
              <span className="text-xs text-muted-foreground">
                {overridden
                  ? t("admin.struct.line.overridden")
                  : t("admin.struct.line.fromComponent")}
              </span>
            </span>
          );
        },
      },
      {
        key: "rate",
        header: t("admin.struct.line.rate"),
        width: "12rem",
        align: "right",
        render: (row) => {
          const component = componentMap.get(row.salary_component_id);
          if (row.percentage_override !== null) {
            return (
              <span className="flex flex-col items-end leading-tight">
                <span className="num">{formatPercent(row.percentage_override)}</span>
                <span className="text-xs text-muted-foreground">
                  {t("admin.struct.line.overridden")}
                </span>
              </span>
            );
          }
          if (row.fixed_amount_override_paise !== null) {
            return (
              <span className="flex flex-col items-end leading-tight">
                <Money paise={row.fixed_amount_override_paise} />
                <span className="text-xs text-muted-foreground">
                  {t("admin.struct.line.overridden")}
                </span>
              </span>
            );
          }
          if (component?.percentage != null) {
            return (
              <span className="flex flex-col items-end leading-tight">
                <span className="num">{formatPercent(component.percentage)}</span>
                <span className="text-xs text-muted-foreground">
                  {t("admin.struct.line.fromComponent")}
                </span>
              </span>
            );
          }
          if (component?.fixed_amount_paise != null) {
            return (
              <span className="flex flex-col items-end leading-tight">
                <Money paise={component.fixed_amount_paise} />
                <span className="text-xs text-muted-foreground">
                  {t("admin.struct.line.fromComponent")}
                </span>
              </span>
            );
          }
          return dash(null);
        },
      },
      {
        key: "min_amount_paise",
        header: t("admin.struct.line.min"),
        width: "10rem",
        align: "right",
        hideBelow: "lg",
        render: (row) =>
          row.min_amount_paise === null ? dash(null) : <Money paise={row.min_amount_paise} />,
      },
      {
        key: "max_amount_paise",
        header: t("admin.struct.line.max"),
        width: "10rem",
        align: "right",
        hideBelow: "lg",
        render: (row) =>
          row.max_amount_paise === null ? dash(null) : <Money paise={row.max_amount_paise} />,
      },
      {
        key: "is_mandatory",
        header: t("admin.struct.line.mandatory"),
        width: "8rem",
        align: "center",
        hideBelow: "md",
        render: (row) => (row.is_mandatory ? t("common.yes") : t("common.no")),
      },
    ],
    [componentMap],
  );

  const kindOptions = useMemo(
    () =>
      Object.entries(STRUCTURE_KIND_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    [],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.struct.title")}
        subtitle={t("admin.struct.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.struct.readOnly")}
      </Notice>

      <StateBoundary
        loading={structures.isPending}
        error={structures.error}
        onRetry={() => void structures.refetch()}
        partialError={grades.error}
        partialLabel={t("admin.struct.partial.grades")}
        skeletonRows={5}
      >
        <DataGrid
          columns={structureColumns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          onRowClick={(row) => setParam("structure", row.id)}
          toolbar={
            <div className="grid w-full gap-3 sm:max-w-md sm:grid-cols-2">
              <SelectField
                label={t("admin.struct.filter.kind")}
                value={kindFilter}
                options={kindOptions}
                placeholder={t("admin.struct.filter.anyKind")}
                onChange={(value) => setParam("kind", value)}
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  variant={includeInactive ? "default" : "outline"}
                  onClick={() => setParam("inactive", includeInactive ? "" : "1")}
                  aria-pressed={includeInactive}
                >
                  {t("admin.struct.filter.includeInactive")}
                </Button>
              </div>
            </div>
          }
          emptyState={
            <EmptyState
              icon={Banknote}
              title={t("admin.struct.empty.title")}
              hint={
                kindFilter !== ""
                  ? t("admin.struct.empty.filtered")
                  : t("admin.struct.empty.hint")
              }
            />
          }
        />
      </StateBoundary>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">
          {selected === null
            ? t("admin.struct.lines.heading")
            : t("admin.struct.lines.headingFor", { code: selected.code, name: selected.name })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.struct.lines.hint")}</p>

        <div className="mt-4">
          {selectedId === null ? (
            <EmptyState
              icon={Layers}
              title={t("admin.struct.lines.none.title")}
              hint={t("admin.struct.lines.none.hint")}
            />
          ) : (
            <StateBoundary
              loading={lines.isPending}
              error={lines.error}
              onRetry={() => void lines.refetch()}
              partialError={components.error}
              partialLabel={t("admin.struct.partial.components")}
              skeletonRows={4}
            >
              <DataGrid
                columns={lineColumns}
                rows={lines.data ?? []}
                rowKey={(row) => row.id}
                pageSize={50}
                emptyState={
                  <EmptyState
                    icon={Layers}
                    title={t("admin.struct.lines.empty.title")}
                    hint={t("admin.struct.lines.empty.hint")}
                  />
                }
              />
            </StateBoundary>
          )}
        </div>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.struct.footnote")}</p>
    </div>
  );
}
