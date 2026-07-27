/**
 * /admin/org/departments — the department master (spec-admin §3, §4).
 *
 * Departments are the spine of the product: an employee, a roster line, an
 * attendance exception and a payroll cost line are all filed under one. The two
 * fields that actually change behaviour are called out in the form — whether the
 * department runs the floor (rosters and event staffing draw from operational
 * departments only) and which cost centre its payroll lands in.
 *
 * @route /admin/org/departments
 */
import { Building2 } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Department, OrgListFilters } from "../api/org.api";
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

function useDepartmentRows(filters: OrgListFilters) {
  return useOrgList("departments", filters);
}

function nameOf(options: readonly RefOption[] | undefined, id: string | null): string {
  if (id === null) return dash(null);
  return options?.find((option) => option.id === id)?.name ?? dash(null);
}

export default function DepartmentsPage() {
  const companyId = useDefaultCompanyId();
  const costCentres = useRefOptions("costCentres");
  const employees = useEmployeeRefOptions();

  const groups: FieldGroup[] = [
    identityGroup(),
    {
      title: t("admin.org.dept.group.ownership"),
      fields: [
        {
          name: "head_employee_id",
          label: t("admin.org.dept.field.head"),
          kind: "select",
          help: t("admin.org.dept.help.head"),
          options: refOptions(employees.data),
        },
        {
          name: "cost_centre_id",
          label: t("admin.org.dept.field.costCentre"),
          kind: "select",
          help: t("admin.org.dept.help.costCentre"),
          options: refOptions(costCentres.data),
        },
        {
          name: "is_operational",
          label: t("admin.org.dept.field.isOperational"),
          kind: "checkbox",
          help: t("admin.org.dept.help.isOperational"),
        },
      ],
    },
  ];

  const columns: DataGridColumn<Department>[] = [
    {
      key: "head_employee_id",
      header: t("admin.org.dept.col.head"),
      hideBelow: "md",
      render: (row) => nameOf(employees.data, row.head_employee_id),
    },
    {
      key: "cost_centre_id",
      header: t("admin.org.dept.col.costCentre"),
      hideBelow: "lg",
      render: (row) => nameOf(costCentres.data, row.cost_centre_id),
    },
    {
      key: "is_operational",
      header: t("admin.org.dept.col.operational"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.is_operational ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "sort_order",
      header: t("admin.master.col.order"),
      width: "6rem",
      align: "right",
      hideBelow: "lg",
      sortable: true,
      sortValue: (row) => row.sort_order,
    },
  ];

  return (
    <MasterScreen<Department>
      icon={Building2}
      title={t("admin.org.dept.title")}
      subtitle={t("admin.org.dept.subtitle")}
      entityLabel={t("admin.org.dept.entity")}
      entity="departments"
      useRows={useDepartmentRows}
      partialError={costCentres.error ?? employees.error ?? undefined}
      partialLabel={t("admin.org.dept.col.head")}
      columns={columns}
      groups={groups}
      createDefaults={{ ...BASE_CREATE_DEFAULTS, is_operational: "true" }}
      needsCompanyId
      companyId={companyId}
      retire="archive"
    />
  );
}
