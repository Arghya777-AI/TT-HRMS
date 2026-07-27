/**
 * /admin/time/weekly-offs — weekly-off rules (spec-admin §6.2).
 *
 * Two things this screen refuses to do:
 *  - print "Weeks 1,2,3,4,5" twice and call it a pattern (DR-60). The grid's
 *    first job is the sentence: "Sunday every week + 2nd & 4th Saturday".
 *  - offer a retire action. `weekly_off_rules` has no `deleted_at` column, so
 *    withdrawing one is `is_active = false` and the button says Deactivate,
 *    because that is what actually happens.
 *
 * @route /admin/time/weekly-offs
 */
import { CalendarDays } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { OrgListFilters, WeeklyOffRule } from "../api/org.api";
import { useDefaultCompanyId, useOrgList } from "../hooks/useMasters";
import { MasterBanner, MasterScreen } from "../components/MasterScreen";
import { dowLabel, type FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";
import { weeklyOffSentence } from "../masters/weeklyOff";

function useWeeklyOffRows(filters: OrgListFilters) {
  return useOrgList("weeklyOffRules", filters);
}

const RULE_KINDS = [
  { value: "fixed_weekdays", label: t("admin.time.woff.kind.fixed_weekdays") },
  { value: "rotational", label: t("admin.time.woff.kind.rotational") },
  { value: "roster_driven", label: t("admin.time.woff.kind.roster_driven") },
  { value: "days_per_week", label: t("admin.time.woff.kind.days_per_week") },
] as const;

const BASES = [
  { value: "calendar_dom", label: t("admin.time.woff.basis.calendar_dom") },
  { value: "iso_week_parity", label: t("admin.time.woff.basis.iso_week_parity") },
] as const;

const groups: FieldGroup[] = [
  identityGroup([
    {
      name: "rule_kind",
      label: t("admin.time.woff.field.ruleKind"),
      kind: "select",
      help: t("admin.time.woff.help.ruleKind"),
      required: true,
      options: RULE_KINDS,
    },
  ]),
  {
    title: t("admin.time.woff.group.pattern"),
    fields: [
      {
        name: "first_off_dow",
        label: t("admin.time.woff.field.firstOff"),
        kind: "dow",
        help: t("admin.time.woff.help.offDay"),
      },
      {
        name: "first_off_weeks",
        label: t("admin.time.woff.field.firstWeeks"),
        kind: "weeks",
        help: t("admin.time.woff.help.weeks"),
      },
      {
        name: "second_off_dow",
        label: t("admin.time.woff.field.secondOff"),
        kind: "dow",
        help: t("admin.time.woff.help.offDay"),
      },
      {
        name: "second_off_weeks",
        label: t("admin.time.woff.field.secondWeeks"),
        kind: "weeks",
        help: t("admin.time.woff.help.weeks"),
      },
      {
        name: "third_off_dow",
        label: t("admin.time.woff.field.thirdOff"),
        kind: "dow",
        help: t("admin.time.woff.help.offDay"),
      },
      {
        name: "third_off_weeks",
        label: t("admin.time.woff.field.thirdWeeks"),
        kind: "weeks",
        help: t("admin.time.woff.help.weeks"),
      },
      {
        name: "week_of_month_basis",
        label: t("admin.time.woff.field.basis"),
        kind: "select",
        help: t("admin.time.woff.help.basis"),
        required: true,
        options: BASES,
      },
      {
        name: "half_day_dow",
        label: t("admin.time.woff.field.halfDay"),
        kind: "dow",
        help: t("admin.time.woff.help.halfDay"),
      },
      {
        name: "offs_per_week",
        label: t("admin.time.woff.field.offsPerWeek"),
        kind: "number",
        help: t("admin.time.woff.help.offsPerWeek"),
        min: 0,
        max: 7,
      },
    ],
  },
  {
    title: t("admin.time.woff.group.rotation"),
    fields: [
      {
        name: "is_rotational",
        label: t("admin.time.woff.field.isRotational"),
        kind: "checkbox",
        help: t("admin.time.woff.help.isRotational"),
      },
      {
        name: "rotation_pattern",
        label: t("admin.time.woff.field.rotationPattern"),
        kind: "dowList",
        help: t("admin.time.woff.help.rotationPattern"),
        placeholder: "2,3",
        pattern: { re: /^[0-6](,[0-6])*$/, messageKey: "admin.master.err.pattern.numberList" },
      },
      {
        name: "rotation_anchor_date",
        label: t("admin.time.woff.field.anchor"),
        kind: "date",
        help: t("admin.time.woff.help.anchor"),
      },
    ],
  },
];

const columns: DataGridColumn<WeeklyOffRule>[] = [
  {
    key: "pattern",
    header: t("admin.time.woff.col.pattern"),
    render: (row) => weeklyOffSentence(row),
  },
  {
    key: "rule_kind",
    header: t("admin.time.woff.col.kind"),
    width: "11rem",
    hideBelow: "lg",
    render: (row) =>
      RULE_KINDS.find((kind) => kind.value === row.rule_kind)?.label ?? dash(row.rule_kind),
  },
  {
    key: "half_day_dow",
    header: t("admin.time.woff.col.halfDay"),
    width: "8rem",
    hideBelow: "lg",
    render: (row) => (row.half_day_dow === null ? dash(null) : dowLabel(row.half_day_dow)),
  },
];

export default function WeeklyOffsPage() {
  const companyId = useDefaultCompanyId();

  return (
    <MasterScreen<WeeklyOffRule>
      icon={CalendarDays}
      title={t("admin.time.woff.title")}
      subtitle={t("admin.time.woff.subtitle")}
      entityLabel={t("admin.time.woff.entity")}
      entity="weeklyOffRules"
      useRows={useWeeklyOffRows}
      columns={columns}
      groups={groups}
      createDefaults={{
        ...BASE_CREATE_DEFAULTS,
        rule_kind: "fixed_weekdays",
        week_of_month_basis: "calendar_dom",
        first_off_weeks: "1,2,3,4,5",
        is_rotational: "false",
      }}
      needsCompanyId
      companyId={companyId}
      // No deleted_at on this table — deactivate, and say deactivate.
      retire="flag"
      promptOnSave
      banner={<MasterBanner>{t("admin.time.woff.banner")}</MasterBanner>}
    />
  );
}
