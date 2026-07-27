/**
 * /admin/org/designations — job titles (spec-admin §4).
 *
 * A designation is not just a label: it carries the grade a new hire inherits,
 * the shift they start on, and whether overtime is payable at all. The overtime
 * flag is stated as the AND it really is — designation eligible AND policy
 * enabled — because "OT eligible" on its own reads like a promise.
 *
 * @route /admin/org/designations
 */
import { BadgeCheck } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Designation, OrgListFilters } from "../api/org.api";
import {
  useDefaultCompanyId,
  useOrgList,
  useRefOptions,
  type RefOption,
} from "../hooks/useMasters";
import { MasterScreen } from "../components/MasterScreen";
import { refOptions, type FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useDesignationRows(filters: OrgListFilters) {
  return useOrgList("designations", filters);
}

function nameOf(options: readonly RefOption[] | undefined, id: string | null): string {
  if (id === null) return dash(null);
  return options?.find((option) => option.id === id)?.name ?? dash(null);
}

export default function DesignationsPage() {
  const companyId = useDefaultCompanyId();
  const grades = useRefOptions("grades");
  const shifts = useRefOptions("shifts");

  const groups: FieldGroup[] = [
    identityGroup(),
    {
      title: t("admin.org.desig.group.defaults"),
      fields: [
        {
          name: "grade_id",
          label: t("admin.org.desig.field.grade"),
          kind: "select",
          help: t("admin.org.desig.help.grade"),
          options: refOptions(grades.data),
        },
        {
          name: "default_shift_id",
          label: t("admin.org.desig.field.defaultShift"),
          kind: "select",
          help: t("admin.org.desig.help.defaultShift"),
          options: refOptions(shifts.data),
        },
        {
          name: "ot_eligible",
          label: t("admin.org.desig.field.otEligible"),
          kind: "checkbox",
          help: t("admin.org.desig.help.otEligible"),
        },
        {
          name: "is_managerial",
          label: t("admin.org.desig.field.isManagerial"),
          kind: "checkbox",
          help: t("admin.org.desig.help.isManagerial"),
        },
        {
          name: "is_executive",
          label: t("admin.org.desig.field.isExecutive"),
          kind: "checkbox",
          help: t("admin.org.desig.help.isExecutive"),
        },
      ],
    },
  ];

  const columns: DataGridColumn<Designation>[] = [
    {
      key: "grade_id",
      header: t("admin.org.desig.col.grade"),
      hideBelow: "md",
      render: (row) => nameOf(grades.data, row.grade_id),
    },
    {
      key: "default_shift_id",
      header: t("admin.org.desig.col.shift"),
      hideBelow: "lg",
      render: (row) => nameOf(shifts.data, row.default_shift_id),
    },
    {
      key: "ot_eligible",
      header: t("admin.org.desig.col.ot"),
      width: "8rem",
      render: (row) => (row.ot_eligible ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "is_managerial",
      header: t("admin.org.desig.field.isManagerial"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => (row.is_managerial ? t("admin.master.yes") : t("admin.master.no")),
    },
  ];

  return (
    <MasterScreen<Designation>
      icon={BadgeCheck}
      title={t("admin.org.desig.title")}
      subtitle={t("admin.org.desig.subtitle")}
      entityLabel={t("admin.org.desig.entity")}
      entity="designations"
      useRows={useDesignationRows}
      partialError={grades.error ?? shifts.error ?? undefined}
      partialLabel={t("admin.org.desig.col.grade")}
      columns={columns}
      groups={groups}
      createDefaults={{ ...BASE_CREATE_DEFAULTS, ot_eligible: "true" }}
      needsCompanyId
      companyId={companyId}
      retire="archive"
    />
  );
}
