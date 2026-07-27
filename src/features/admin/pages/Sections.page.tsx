/**
 * /admin/org/sections — sub-units inside a department (spec-admin §4).
 *
 * `sections` is the one org master with no `company_id`: it hangs off a
 * department, and that parent is the field the form makes prominent. The grid can
 * be narrowed to one department, because "Hot" and "Stores" mean nothing until
 * you know they are Kitchen's.
 *
 * @route /admin/org/sections
 */
import { useMemo, useState } from "react";
import { Building2 } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { OrgListFilters, Section } from "../api/org.api";
import {
  useEmployeeRefOptions,
  useOrgList,
  useRefOptions,
  type RefOption,
} from "../hooks/useMasters";
import { MasterScreen } from "../components/MasterScreen";
import { refOptions, type FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useSectionRows(filters: OrgListFilters) {
  return useOrgList("sections", filters);
}

function nameOf(options: readonly RefOption[] | undefined, id: string | null): string {
  if (id === null) return dash(null);
  return options?.find((option) => option.id === id)?.name ?? dash(null);
}

export default function SectionsPage() {
  const departments = useRefOptions("departments");
  const employees = useEmployeeRefOptions();
  const [departmentId, setDepartmentId] = useState("");

  const extraFilters: OrgListFilters | undefined = useMemo(
    () => (departmentId === "" ? undefined : { parent: { department_id: departmentId } }),
    [departmentId],
  );

  const groups: FieldGroup[] = [
    {
      title: t("admin.org.section.field.department"),
      fields: [
        {
          name: "department_id",
          label: t("admin.org.section.field.department"),
          kind: "select",
          help: t("admin.org.section.help.department"),
          required: true,
          options: refOptions(departments.data),
          wide: true,
        },
      ],
    },
    identityGroup(),
    {
      title: t("admin.org.section.field.head"),
      fields: [
        {
          name: "head_employee_id",
          label: t("admin.org.section.field.head"),
          kind: "select",
          help: t("admin.org.section.help.head"),
          options: refOptions(employees.data),
          wide: true,
        },
      ],
    },
  ];

  const columns: DataGridColumn<Section>[] = [
    {
      key: "department_id",
      header: t("admin.org.section.col.department"),
      render: (row) => nameOf(departments.data, row.department_id),
    },
    {
      key: "head_employee_id",
      header: t("admin.org.section.field.head"),
      hideBelow: "lg",
      render: (row) => nameOf(employees.data, row.head_employee_id),
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
    <MasterScreen<Section>
      icon={Building2}
      title={t("admin.org.section.title")}
      subtitle={t("admin.org.section.subtitle")}
      entityLabel={t("admin.org.section.entity")}
      entity="sections"
      useRows={useSectionRows}
      partialError={departments.error ?? employees.error ?? undefined}
      partialLabel={t("admin.org.section.col.department")}
      columns={columns}
      groups={groups}
      createDefaults={BASE_CREATE_DEFAULTS}
      retire="archive"
      {...(extraFilters !== undefined ? { extraFilters } : {})}
      toolbarExtra={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("admin.org.section.col.department")}</span>
          <select
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">{t("admin.org.section.filter.allDepartments")}</option>
            {(departments.data ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
