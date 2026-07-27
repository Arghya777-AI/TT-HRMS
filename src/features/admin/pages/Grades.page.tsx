/**
 * /admin/org/grades — grades and bands (spec-admin §4).
 *
 * `level` is the field people misread as a salary, so the help says what it
 * actually does: it orders grades. The band is entered in rupees and stored to
 * the paisa — a grade band is organisation policy, not a person's pay, so it is
 * rendered plainly (D-19 masking applies to an individual's compensation, which
 * lives in `employee_salary_revisions` and is masked there).
 *
 * @route /admin/org/grades
 */
import { Layers } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { formatPaise } from "@/lib/money";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Grade, OrgListFilters } from "../api/org.api";
import { useDefaultCompanyId, useOrgList } from "../hooks/useMasters";
import { MasterScreen } from "../components/MasterScreen";
import type { FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useGradeRows(filters: OrgListFilters) {
  return useOrgList("grades", filters);
}

function bandOf(row: Grade): string {
  if (row.min_ctc_monthly_paise === null && row.max_ctc_monthly_paise === null) {
    return t("admin.org.grade.bandOpen");
  }
  return t("admin.master.range", {
    from: formatPaise(row.min_ctc_monthly_paise),
    to: formatPaise(row.max_ctc_monthly_paise),
  });
}

export default function GradesPage() {
  const companyId = useDefaultCompanyId();

  const groups: FieldGroup[] = [
    identityGroup([
      {
        name: "level",
        label: t("admin.org.grade.field.level"),
        kind: "number",
        help: t("admin.org.grade.help.level"),
        required: true,
        min: 1,
        max: 20,
      },
    ]),
    {
      title: t("admin.org.grade.group.band"),
      fields: [
        {
          name: "min_ctc_monthly_paise",
          label: t("admin.org.grade.field.minCtc"),
          kind: "rupees",
          help: t("admin.org.grade.help.minCtc"),
          min: 0,
        },
        {
          name: "max_ctc_monthly_paise",
          label: t("admin.org.grade.field.maxCtc"),
          kind: "rupees",
          help: t("admin.org.grade.help.maxCtc"),
          min: 0,
        },
      ],
    },
    {
      title: t("admin.org.grade.group.terms"),
      fields: [
        {
          name: "probation_months",
          label: t("admin.org.grade.field.probation"),
          kind: "number",
          help: t("admin.org.grade.help.probation"),
          min: 0,
          max: 24,
        },
        {
          name: "notice_period_days",
          label: t("admin.org.grade.field.notice"),
          kind: "number",
          help: t("admin.org.grade.help.notice"),
          min: 0,
          max: 365,
        },
      ],
    },
  ];

  const columns: DataGridColumn<Grade>[] = [
    {
      key: "level",
      header: t("admin.org.grade.col.level"),
      width: "6rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.level,
    },
    {
      key: "band",
      header: t("admin.org.grade.col.band"),
      align: "right",
      hideBelow: "md",
      render: (row) => bandOf(row),
    },
    {
      key: "probation_months",
      header: t("admin.org.grade.col.probation"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        dash(row.probation_months, (n) => t("admin.org.grade.months", { n })),
    },
    {
      key: "notice_period_days",
      header: t("admin.org.grade.col.notice"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => dash(row.notice_period_days, (n) => t("admin.org.grade.days", { n })),
    },
  ];

  return (
    <MasterScreen<Grade>
      icon={Layers}
      title={t("admin.org.grade.title")}
      subtitle={t("admin.org.grade.subtitle")}
      entityLabel={t("admin.org.grade.entity")}
      entity="grades"
      useRows={useGradeRows}
      columns={columns}
      groups={groups}
      createDefaults={BASE_CREATE_DEFAULTS}
      needsCompanyId
      companyId={companyId}
      retire="archive"
    />
  );
}
