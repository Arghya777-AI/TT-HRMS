/**
 * /admin/org/cost-centres — where payroll cost is booked (spec-admin §4).
 *
 * The parent picker excludes the row being edited, because a cost centre that
 * rolls up into itself makes every finance roll-up recurse. The budget is a
 * reference figure and the help says so — nothing here blocks a payroll run.
 *
 * @route /admin/org/cost-centres
 */
import { Wallet } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { formatPaise } from "@/lib/money";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { CostCentre, OrgListFilters } from "../api/org.api";
import {
  useDefaultCompanyId,
  useEmployeeRefOptions,
  useOrgList,
  useRefOptions,
  type RefOption,
} from "../hooks/useMasters";
import { MasterScreen } from "../components/MasterScreen";
import { refOptions, type FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useCostCentreRows(filters: OrgListFilters) {
  return useOrgList("costCentres", filters);
}

function nameOf(options: readonly RefOption[] | undefined, id: string | null): string {
  if (id === null) return dash(null);
  return options?.find((option) => option.id === id)?.name ?? dash(null);
}

export default function CostCentresPage() {
  const companyId = useDefaultCompanyId();
  const centres = useRefOptions("costCentres");
  const employees = useEmployeeRefOptions();

  const groupsFor = (row: CostCentre | null): FieldGroup[] => [
    identityGroup(),
    {
      title: t("admin.org.cc.group.finance"),
      fields: [
        {
          name: "parent_cost_centre_id",
          label: t("admin.org.cc.field.parent"),
          kind: "select",
          help: t("admin.org.cc.help.parent"),
          // A centre cannot roll up into itself.
          options: refOptions(centres.data, row?.id),
        },
        {
          name: "owner_employee_id",
          label: t("admin.org.cc.field.owner"),
          kind: "select",
          help: t("admin.org.cc.help.owner"),
          options: refOptions(employees.data),
        },
        {
          name: "budget_monthly_paise",
          label: t("admin.org.cc.field.budget"),
          kind: "rupees",
          help: t("admin.org.cc.help.budget"),
          min: 0,
        },
      ],
    },
  ];

  const columns: DataGridColumn<CostCentre>[] = [
    {
      key: "parent_cost_centre_id",
      header: t("admin.org.cc.col.parent"),
      hideBelow: "md",
      render: (row) => nameOf(centres.data, row.parent_cost_centre_id),
    },
    {
      key: "owner_employee_id",
      header: t("admin.org.cc.col.owner"),
      hideBelow: "lg",
      render: (row) => nameOf(employees.data, row.owner_employee_id),
    },
    {
      key: "budget_monthly_paise",
      header: t("admin.org.cc.col.budget"),
      align: "right",
      width: "11rem",
      render: (row) => formatPaise(row.budget_monthly_paise),
    },
  ];

  return (
    <MasterScreen<CostCentre>
      icon={Wallet}
      title={t("admin.org.cc.title")}
      subtitle={t("admin.org.cc.subtitle")}
      entityLabel={t("admin.org.cc.entity")}
      entity="costCentres"
      useRows={useCostCentreRows}
      partialError={centres.error ?? employees.error ?? undefined}
      partialLabel={t("admin.org.cc.col.owner")}
      columns={columns}
      groups={groupsFor(null)}
      groupsFor={groupsFor}
      createDefaults={BASE_CREATE_DEFAULTS}
      needsCompanyId
      companyId={companyId}
      retire="archive"
    />
  );
}
