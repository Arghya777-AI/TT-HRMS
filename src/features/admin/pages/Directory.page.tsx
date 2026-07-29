/**
 * §2 · /admin/people — Employee Directory. Every employee, filterable.
 *
 * This is the screen an HR administrator opens first and the entry point to
 * every other thing they can do to a person, so three things matter more here
 * than anywhere else:
 *
 *  1. THE TOTAL IS POSTGRES'S. The header count comes from a `HEAD … count=exact`
 *     against `v_admin_employee` using the SAME filter array as the paged read
 *     (see `usePeople.ts`). Counting the loaded rows would make the figure
 *     depend on how far the admin has scrolled — the classic "7 of 8" defect.
 *  2. FILTERS ARE AND-ONLY, AND THE SCREEN SAYS SO. `DirectoryFilters` refuses
 *     to build an OR across name, code and mobile, because that needs raw
 *     PostgREST syntax the query layer bans. So the admin picks WHICH column
 *     they are searching rather than being given a "search everything" box that
 *     silently searches one thing.
 *  3. ARCHIVED ROWS ARE OPT-IN. `v_admin_employee` deliberately shows
 *     soft-deleted rows to admins (migration 051 §1) because the Archive console
 *     needs them. The directory therefore excludes them unless asked, and when
 *     asked it shows ONLY them — that is the archive view, and it is labelled.
 *
 * No arithmetic on this page. Profile completeness is a server-computed
 * percentage; tenure and confirmation dates are server columns.
 *
 * @route /admin/people
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { SelectField, TextField } from "../components/Field";
import { PersonCell } from "../components/PersonCell";
import { useRefOptions } from "../hooks/useMasters";
import { OnboardingQueuePanel } from "@/features/onboarding/components/OnboardingQueuePanel";
import { RolePanel } from "../components/RolePanel";
import {
  DIRECTORY_PAGE_SIZE,
  flattenDirectory,
  useDirectoryCount,
  useEmployeeDirectory,
} from "../hooks/usePeople";
import {
  EMPLOYMENT_STATUS_LABELS,
  employmentStatusValues,
  employmentTypeValues,
  EMPLOYMENT_TYPE_LABELS,
  type DirectoryFilters,
  type DirectoryRow,
  type EmploymentStatus,
  type EmploymentType,
} from "../api/employees.api";

/**
 * Tone per lifecycle state. `absconding` and `suspended` are the two an admin
 * must never miss in a scan of the grid, so they are the only danger tones.
 */
const STATUS_CHIP: Readonly<Record<EmploymentStatus, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "info" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "warn" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
  on_long_leave: { label: EMPLOYMENT_STATUS_LABELS.on_long_leave, tone: "info" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "info" },
};

/** Which column the one search box applies to (see rule 2 in the header). */
type SearchField = "name" | "code" | "mobile";

const SEARCH_FIELDS: readonly { value: SearchField; label: string }[] = [
  { value: "name", label: t("admin.people.search.byName") },
  { value: "code", label: t("admin.people.search.byCode") },
  { value: "mobile", label: t("admin.people.search.byMobile") },
];

export default function DirectoryPage() {
  const navigate = useNavigate();

  const [searchField, setSearchField] = useState<SearchField>("name");
  const [searchTerm, setSearchTerm] = useState("");
  const [status, setStatus] = useState<EmploymentStatus | "">("");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">("");
  const [departmentId, setDepartmentId] = useState("");
  const [designationId, setDesignationId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [archived, setArchived] = useState(false);

  const departments = useRefOptions("departments");
  const designations = useRefOptions("designations");
  const locations = useRefOptions("locations");

  const filters = useMemo<DirectoryFilters>(() => {
    const term = searchTerm.trim();
    return {
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(employmentType !== "" ? { employmentTypes: [employmentType] } : {}),
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(designationId !== "" ? { designationIds: [designationId] } : {}),
      ...(locationId !== "" ? { locationIds: [locationId] } : {}),
      ...(term !== "" && searchField === "name" ? { nameLike: term } : {}),
      ...(term !== "" && searchField === "code" ? { employeeCode: term } : {}),
      ...(term !== "" && searchField === "mobile" ? { mobileLike: term } : {}),
      ...(archived ? { archived: true } : {}),
    };
  }, [
    searchTerm,
    searchField,
    status,
    employmentType,
    departmentId,
    designationId,
    locationId,
    archived,
  ]);

  const directory = useEmployeeDirectory(filters);
  const total = useDirectoryCount(filters);
  const rows = flattenDirectory(directory.data);

  const hasAnyFilter =
    searchTerm.trim() !== "" ||
    status !== "" ||
    employmentType !== "" ||
    departmentId !== "" ||
    designationId !== "" ||
    locationId !== "" ||
    archived;

  const clearAll = () => {
    setSearchTerm("");
    setStatus("");
    setEmploymentType("");
    setDepartmentId("");
    setDesignationId("");
    setLocationId("");
    setArchived(false);
  };

  const columns: DataGridColumn<DirectoryRow>[] = [
    {
      key: "display_name",
      header: t("admin.people.col.employee"),
      width: "16rem",
      sortable: true,
      render: (row) => (
        <PersonCell
          name={row.display_name}
          code={row.employee_code}
          secondary={row.designation_name}
        />
      ),
    },
    {
      key: "department_name",
      header: t("admin.people.col.department"),
      sortable: true,
      render: (row) => dash(row.department_name),
    },
    {
      key: "section_name",
      header: t("admin.people.col.section"),
      hideBelow: "lg",
      render: (row) => dash(row.section_name),
    },
    {
      key: "location_name",
      header: t("admin.people.col.location"),
      hideBelow: "md",
      render: (row) => dash(row.location_name),
    },
    {
      key: "employment_status",
      header: t("admin.people.col.status"),
      width: "9rem",
      sortable: true,
      render: (row) => <StatusChip status={row.employment_status} map={STATUS_CHIP} />,
    },
    {
      key: "employment_type",
      header: t("admin.people.col.type"),
      hideBelow: "lg",
      render: (row) => dash(EMPLOYMENT_TYPE_LABELS[row.employment_type]),
    },
    {
      key: "shift_code",
      header: t("admin.people.col.shift"),
      hideBelow: "lg",
      render: (row) => dash(row.shift_code),
    },
    {
      key: "reporting_manager_name",
      header: t("admin.people.col.manager"),
      hideBelow: "lg",
      render: (row) => dash(row.reporting_manager_name),
    },
    {
      key: "date_of_join",
      header: t("admin.people.col.joined"),
      width: "9rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.date_of_join)}</span>,
    },
    {
      key: "mobile",
      header: t("admin.people.col.mobile"),
      hideBelow: "md",
      align: "right",
      render: (row) => <span className="num">{dash(row.mobile)}</span>,
    },
    {
      key: "profile_completeness_pct",
      header: t("admin.people.col.complete"),
      hideBelow: "lg",
      align: "right",
      sortable: true,
      // Already a percentage from the view — never computed here.
      render: (row) => (
        <span className="num">{formatPercent(row.profile_completeness_pct)}</span>
      ),
    },
  ];

  const subtitle = total.isSuccess
    ? archived
      ? t("admin.people.subtitle.archived", { n: formatNumber(total.data) })
      : t("admin.people.subtitle.count", { n: formatNumber(total.data) })
    : t("admin.people.subtitle.plain");

  return (
    <div className="container py-6">
      <PageHeader
        icon={Users}
        title={t("admin.people.title")}
        subtitle={subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* The maker-checker queue is a sibling of the directory, and HR has
                to be able to reach it from the section landing. */}
            <Button variant="outline" onClick={() => void navigate("/admin/people/changes")}>
              {t("admin.chq.navFromDirectory")}
            </Button>
            <Button onClick={() => void navigate("/admin/people/new")}>
              <UserPlus className="mr-2 size-4" aria-hidden />
              {t("admin.people.action.add")}
            </Button>
          </div>
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.people.filter.searchIn")}
          value={searchField}
          options={SEARCH_FIELDS}
          onChange={(v) => setSearchField(v as SearchField)}
          hint={t("admin.people.filter.searchInHint")}
        />
        <TextField
          label={t("admin.people.filter.search")}
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={t("admin.people.filter.searchPlaceholder")}
        />
        <SelectField
          label={t("admin.people.filter.status")}
          value={status}
          placeholder={t("admin.people.filter.anyStatus")}
          options={employmentStatusValues.map((v) => ({
            value: v,
            label: EMPLOYMENT_STATUS_LABELS[v],
          }))}
          onChange={(v) => setStatus(v as EmploymentStatus | "")}
        />
        <SelectField
          label={t("admin.people.filter.type")}
          value={employmentType}
          placeholder={t("admin.people.filter.anyType")}
          options={employmentTypeValues.map((v) => ({
            value: v,
            label: EMPLOYMENT_TYPE_LABELS[v],
          }))}
          onChange={(v) => setEmploymentType(v as EmploymentType | "")}
        />
        <SelectField
          label={t("admin.people.filter.department")}
          value={departmentId}
          placeholder={t("admin.people.filter.anyDepartment")}
          options={(departments.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          onChange={setDepartmentId}
        />
        <SelectField
          label={t("admin.people.filter.designation")}
          value={designationId}
          placeholder={t("admin.people.filter.anyDesignation")}
          options={(designations.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          onChange={setDesignationId}
        />
        <SelectField
          label={t("admin.people.filter.location")}
          value={locationId}
          placeholder={t("admin.people.filter.anyLocation")}
          options={(locations.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          onChange={setLocationId}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={archived ? "default" : "outline"}
            onClick={() => setArchived((v) => !v)}
            aria-pressed={archived}
          >
            {t("admin.people.filter.archivedToggle")}
          </Button>
          {hasAnyFilter ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.people.filter.clearAll")}
            </Button>
          ) : null}
        </div>
      </div>

      {archived ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("admin.people.archivedNotice")}</p>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={directory.isPending}
          error={directory.error}
          onRetry={() => void directory.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error}
          partialLabel={t("admin.people.partial.total")}
          empty={
            hasAnyFilter ? (
              <EmptyState
                icon={Users}
                title={t("admin.people.empty.filtered.title")}
                hint={t("admin.people.empty.filtered.hint")}
                action={
                  <Button variant="outline" onClick={clearAll}>
                    {t("admin.people.filter.clearAll")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                title={t("admin.people.empty.title")}
                hint={t("admin.people.empty.hint")}
                action={
                  <Button onClick={() => void navigate("/admin/people/new")}>
                    {t("admin.people.action.add")}
                  </Button>
                }
              />
            )
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={DIRECTORY_PAGE_SIZE}
            onRowClick={(row) => void navigate(`/admin/people/${row.employee_code}`)}
          />

          {directory.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void directory.fetchNextPage()}
                disabled={directory.isFetchingNextPage}
              >
                {directory.isFetchingNextPage
                  ? t("admin.people.loadingMore")
                  : t("admin.people.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.people.footnote")}</p>
      {/* Who still owes their joining paperwork — the question HR asks while
          already looking at the directory. */}
      <OnboardingQueuePanel />
      {/* Access level sits with the people it applies to, and surfaces the two ways the
          org chart and the role table can disagree — one of which hid three whole teams. */}
      <RolePanel />

    </div>
  );
}
