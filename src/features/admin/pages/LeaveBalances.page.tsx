/**
 * /admin/leave/balances — `v_leave_balance_current` across the organisation.
 *
 * Every figure in this grid is a column of that view, printed as-is. Nothing is
 * summed, averaged or re-derived here, and that is the whole point: the view
 * exposes `available_days` and `available_after_pending` as GENERATED columns
 * over the append-only `leave_ledger`, so this screen, the employee's own leave
 * screen and the payroll engine are reading the same number (DR-29, spec-admin
 * §7.2 "Balance = running ledger sum").
 *
 * Grain is one row per employee × leave type — the grain of the view. The spec's
 * pivot (one row per employee, columns per type) is deliberately NOT built by
 * transposing rows in the browser: a pivot needs an `as_of` parameter the view
 * does not take, and a client-side transpose is exactly the kind of local
 * arithmetic that lets two screens disagree.
 *
 * Row click drills into `/admin/leave/ledger/:code`, which is the ledger behind
 * the balance.
 *
 * @route /admin/leave/balances
 */
import { useMemo, useState } from "react";
import { CalendarDays, Scale } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { AnalyticsExportButtons } from "../components/AnalyticsExportButtons";
import { BulkAdjustSheet } from "../components/BulkAdjustSheet";
import { useMonthlyExtraWork } from "../hooks/useAdminLeave";
import { istToday } from "@/lib/datetime";
import { referenceMonth, suggestWeekOffs } from "../people/weekOffSuggestion";
import { defaultFilters } from "@/lib/analyticsFilters";
import type { ExportColumn } from "@/lib/exportReport";
import {
  columnTypes,
  pivotBalances,
  type PivotedBalance,
} from "../people/leaveBalanceGrid";
import { SelectField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  LEAVE_ROW_CAP,
  useAdminLeaveBalances,
  useAdminLeaveTypes,
} from "../hooks/useAdminLeave";

/**
 * The department this page opens on. A venue-specific default living in one named
 * constant rather than scattered through the component — change this line to open
 * on Ground instead.
 */
const DEFAULT_DEPARTMENT = "Management";

/** Explicit "everyone", so it survives having a default. */
const ALL_DEPARTMENTS = "*";

export default function AdminLeaveBalancesPage() {
  const [params, setParams] = useSearchParams();
  const [bulkOpen, setBulkOpen] = useState(false);

  /*
    THE EXPORT CARRIES THE SAME SUGGESTION THE SHEET SHOWS.

    Asked for explicitly: whatever the screen suggests should be in the file too.
    Both read `referenceMonth(istToday())` and `suggestWeekOffs`, so the number in
    the spreadsheet and the number in the sheet cannot disagree — which they would
    within a day of each other if the file recomputed it its own way.
  */
  const period = useMemo(() => referenceMonth(istToday()), []);
  const extraWork = useMonthlyExtraWork(period.year, period.month);
  const navigate = useNavigate();

  const employeeId = params.get("emp");
  const leaveTypeId = params.get("type");
  /*
    MANAGEMENT BY DEFAULT.

    This page opens on the department the venue actually reads it for: Management
    is 19 people, Ground is 45, and arriving at 86 rows sorted by nobody's
    preference means scrolling every time. `?dept=` in the URL still selects any
    other department, and ALL_DEPARTMENTS is an explicit choice in the picker
    rather than an absence — otherwise "show me everyone" would be unreachable
    once a default exists.

    Falls back to everyone if there is no department by this name, so a venue
    without a Management department is not left staring at an empty grid.
  */
  const departmentParam = params.get("dept");

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const types = useAdminLeaveTypes();
  const balances = useAdminLeaveBalances({ employeeId, leaveTypeId });


  /*
    DEPARTMENT, FROM THE LABEL MAP RATHER THAN A NEW READ.

    `EmployeeLabel` already carries `department`, and `v_leave_balance_current` has
    no department column — so this costs nothing and needs no migration. Asked for
    because the venue reads this page by department: Management is 19 people of 83,
    and scrolling past 45 Ground staff to reach them is the whole complaint.
  */
  const departmentNames = useMemo(() => {
    const seen = new Set<string>();
    for (const label of (labels.data ?? new Map<string, { department: string | null }>()).values()) {
      if (label.department !== null && label.department !== "") seen.add(label.department);
    }
    return [...seen].sort();
  }, [labels.data]);

  const departmentChoices: SelectOption[] = useMemo(
    () => [
      { value: ALL_DEPARTMENTS, label: t("admin.leaveBal.filter.allDepartments") },
      ...departmentNames.map((name) => ({ value: name, label: name })),
    ],
    [departmentNames],
  );

  /* The default only applies while the labels are loaded enough to know the
     department exists; until then it is treated as "everyone", so the grid does not
     flash empty. */
  const departmentName =
    departmentParam ??
    (departmentNames.includes(DEFAULT_DEPARTMENT) ? DEFAULT_DEPARTMENT : ALL_DEPARTMENTS);

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  /* `?? []` builds a NEW array every render, so a memo depending on it never holds
     and the filter below would re-run on every keystroke elsewhere on the page.
     Anchored on `balances.data` itself, which react-query keeps stable. */
  const fetched = useMemo(() => balances.data ?? [], [balances.data]);
  const capped = fetched.length >= LEAVE_ROW_CAP;

  /* Applied after the fetch, which is safe at this size: the whole venue holds ~86
     balance rows against a cap in the hundreds, so nothing is lost to the cap
     before filtering. `capped` still measures the FETCHED count, so that warning
     keeps meaning what it says. */
  const inDepartment = useMemo(() => {
    if (departmentName === ALL_DEPARTMENTS || departmentName === "") return fetched;
    return fetched.filter(
      (row) => labels.data?.get(row.employee_id)?.department === departmentName,
    );
  }, [fetched, departmentName, labels.data]);

  const typeColumns = useMemo(() => columnTypes(types.data ?? []), [types.data]);

  const extraByEmployee = useMemo(() => {
    const map = new Map<string, { extra: number; ot: number }>();
    for (const row of extraWork.data ?? []) {
      map.set(row.employee_id, { extra: row.extra_work_minutes, ot: row.overtime_minutes });
    }
    return map;
  }, [extraWork.data]);
  const rows = useMemo(
    () => pivotBalances(inDepartment, typeColumns),
    [inDepartment, typeColumns],
  );

  /*
    ONE ROW PER EMPLOYEE, ONE COLUMN PER LEAVE TYPE.

    The view returns a row per employee PER TYPE, which made 14 Management staff
    into 28 rows with a "Leave type" cell and a filter to narrow it. The venue reads
    this page against a statement shaped one line per person, so the type moved from
    a cell to a COLUMN HEADER and the type filter went with it — every type is
    visible at once, so there is nothing left to filter.

    The per-type figures went too: Opening, Accrued this month, Lapsed, Spendable
    and Nearest expiry would each need a column per type, and five types by six
    figures is thirty columns nobody reads. The credits and debits behind any number
    are one click away in that employee's ledger.

    The type columns are NOT sortable, as asked: they carry the type's name and the
    number, nothing else.
  */
  /*
    THE EXPORT COLUMNS ARE BUILT FROM THE SAME `typeColumns` AS THE GRID.

    `exportReport` takes the ROWS, not the DOM — deliberately, per its own header:
    scraping the table would export whichever page the reader had paged to, with
    their sort and whatever their viewport hid. Deriving both column sets from one
    array is the same discipline one level up: add a leave type and it appears in
    the file and on screen together, or in neither.

    `filters` carries the department, because a spreadsheet headed "Leave balances"
    that silently holds only Management is a lie about the venue — the engine prints
    it at the top of the file.
  */
  const exportColumns: ExportColumn<PivotedBalance>[] = useMemo(
    () => [
      {
        key: "employee_code",
        header: t("admin.leaveBal.col.employeeCode"),
        format: (row) => labels.data?.get(row.employeeId)?.code ?? "",
      },
      {
        key: "employee",
        header: t("admin.leaveBal.col.employee"),
        format: (row) => labels.data?.get(row.employeeId)?.name ?? "",
      },
      {
        key: "department",
        header: t("admin.leaveBal.filter.department"),
        format: (row) => labels.data?.get(row.employeeId)?.department ?? "",
      },
      ...typeColumns.flatMap((type) => [
        {
          key: `avail:${type.id}`,
          header: t("admin.leaveBal.col.typeAvailable", { type: type.name }),
          align: "right" as const,
          format: (row: PivotedBalance) =>
            String(row.byTypeId.get(type.id)?.available ?? 0),
        },
        {
          key: `used:${type.id}`,
          header: t("admin.leaveBal.col.typeUsed", { type: type.name }),
          align: "right" as const,
          format: (row: PivotedBalance) => String(row.byTypeId.get(type.id)?.used ?? 0),
        },
      ]),
      /*
        Two more columns, at the end: the hours behind the suggestion and the
        suggestion itself. Named with the month they came from, because a column
        headed "Suggested week-offs" with no period on it is worthless a fortnight
        later — the same reason `exportReport` insists on printing the filters.
      */
      {
        key: "extra_work_hours",
        header: t("admin.leaveBal.col.extraWorkIn", { month: period.label }),
        align: "right" as const,
        format: (row: PivotedBalance) => {
          const minutes = extraByEmployee.get(row.employeeId)?.extra;
          return minutes === undefined ? "" : String(Math.round(minutes / 6) / 10);
        },
      },
      {
        key: "suggested_weekoffs",
        header: t("admin.leaveBal.col.suggestedWeekOffs", { month: period.label }),
        align: "right" as const,
        format: (row: PivotedBalance) => {
          const minutes = extraByEmployee.get(row.employeeId)?.extra;
          return minutes === undefined ? "" : String(suggestWeekOffs(minutes));
        },
      },
    ],
    [labels.data, typeColumns, period.label, extraByEmployee],
  );

  const columns: DataGridColumn<PivotedBalance>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.leaveBal.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employeeId)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employeeId);
          return <PersonCell name={label?.name ?? null} code={label?.code ?? null} />;
        },
      },
      /*
        TWO COLUMNS PER TYPE: available, then used.
        
        The header spells out the type and the figure in full — "Earned Leave ·
        available" — rather than grouping them under one type heading. `DataGridColumn.header`
        is a plain string, so a spanning header is not available, and an abbreviated
        one would be guesswork on the reader's part. Mislabelling a number is exactly
        what put 8 under "Accrued this month", so these say what they are.
        
        Available is emphasised because it is the figure most rows are read for; used
        sits beside it in muted type as context, not competition.
      */
      ...typeColumns.flatMap((type) => [
        {
          key: `avail:${type.id}`,
          header: t("admin.leaveBal.col.typeAvailable", { type: type.name }),
          width: "8rem",
          align: "right" as const,
          render: (row: PivotedBalance) => (
            <span className="num font-semibold">
              {formatDays(row.byTypeId.get(type.id)?.available ?? 0)}
            </span>
          ),
        },
        {
          key: `used:${type.id}`,
          header: t("admin.leaveBal.col.typeUsed", { type: type.name }),
          width: "7rem",
          align: "right" as const,
          hideBelow: "lg" as const,
          render: (row: PivotedBalance) => (
            <span className="num text-muted-foreground">
              {formatDays(row.byTypeId.get(type.id)?.used ?? 0)}
            </span>
          ),
        },
      ]),
      {
        key: "ledger",
        header: t("admin.leaveBal.col.ledger"),
        width: "7rem",
        align: "right",
        render: (row) => {
          const code = labels.data?.get(row.employeeId)?.code;
          if (code === undefined) return dash(null);
          /* No `?type=` any more — a pivoted row is not about one type, so the
             ledger opens on the employee and lets them pick. */
          return (
            <span onClick={(event) => event.stopPropagation()}>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/admin/leave/ledger/${code}`}>{t("admin.leaveBal.openLedger")}</Link>
              </Button>
            </span>
          );
        },
      },
      {
        key: "adjust",
        header: t("admin.leaveBal.col.adjust"),
        width: "7rem",
        align: "right",
        render: (row) => (
          /* Prefilled with the employee only, for the same reason: the row no
             longer names a single type. The form still asks for one. */
          <span onClick={(event) => event.stopPropagation()}>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/admin/leave/adjustments?emp=${row.employeeId}`}>
                {t("admin.leaveBal.adjust")}
              </Link>
            </Button>
          </span>
        ),
      },
    ],
    [labels.data, typeColumns],
  );

  /*
    THE SHEET GETS EXACTLY THE ROWS ON SCREEN, department filter included. Offering
    all 83 when the reader had narrowed to Management would answer a question they
    did not ask, and "Adjust all" has to mean all of what they are looking at.
  */
  const bulkPeople = useMemo(
    () =>
      rows.map((row) => {
        const label = labels.data?.get(row.employeeId);
        return {
          employeeId: row.employeeId,
          employeeCode: label?.code ?? "",
          employeeName: label?.name ?? "",
          byTypeId: new Map(
            [...row.byTypeId].map(([typeId, cell]) => [typeId, cell.available]),
          ) as ReadonlyMap<string, number>,
        };
      }),
    [rows, labels.data],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Scale}
        title={t("admin.leaveBal.title")}
        subtitle={t("admin.leaveBal.subtitle")}
        actions={
          /*
            THE WAY IN. `adjust_leave_balance` and `/admin/leave/adjustments` have
            both existed since migration 039300, and neither was reachable from the
            screen where somebody LOOKS at a balance — so the answer to "how do I
            add leave" was "know the URL". One button, on the page where the
            question is asked.
          */
          <div className="flex flex-wrap items-center gap-2">
            <AnalyticsExportButtons
              title={t("admin.leaveBal.title")}
              subtitle={
                departmentName === ALL_DEPARTMENTS
                  ? t("admin.leaveBal.filter.allDepartments")
                  : departmentName
              }
              filename={`leave-balances-${departmentName === ALL_DEPARTMENTS ? "all" : departmentName}`}
              columns={exportColumns}
              rows={rows}
              filters={defaultFilters()}
              {...(departmentName === ALL_DEPARTMENTS ? {} : { labels: { department: departmentName } })}
            />
            <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
              {t("admin.leaveBal.adjustAll")}
            </Button>
            <Button asChild size="sm">
              <Link to="/admin/leave/adjustments">{t("admin.leaveBal.adjustBalance")}</Link>
            </Button>
          </div>
        }
      />

      <BulkAdjustSheet
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        types={typeColumns}
        people={bulkPeople}
        scopeLabel={
          departmentName === ALL_DEPARTMENTS
            ? t("admin.leaveBal.filter.allDepartments")
            : departmentName
        }
      />

      <Notice tone="info" className="mb-4">
        {t("admin.leaveBal.provenance")}
      </Notice>

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("admin.common.rowCap", { count: LEAVE_ROW_CAP })}
        </Notice>
      ) : null}

      <StateBoundary
        loading={balances.isLoading}
        error={balances.error ?? undefined}
        onRetry={() => void balances.refetch()}
        partialError={types.error ?? labels.error ?? undefined}
        partialLabel={t("admin.leaveBal.partial")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.employeeId}:${row.leaveYear}`}
          pageSize={25}
          onRowClick={(row) => {
            const code = labels.data?.get(row.employeeId)?.code;
            if (code === undefined) return;
            navigate(`/admin/leave/ledger/${code}`);
          }}
          toolbar={
            <div className="grid w-full gap-3 sm:grid-cols-2">
              <SelectField
                label={t("admin.leaveBal.filter.department")}
                value={departmentName}
                options={departmentChoices}
                onChange={(value) => setParam("dept", value)}
                disabled={labels.isLoading}
              />
              <SelectField
                label={t("admin.common.filter.employee")}
                value={employeeId ?? ""}
                options={employeeChoices}
                placeholder={t("admin.common.filter.allEmployees")}
                onChange={(value) => setParam("emp", value)}
                disabled={labels.isLoading}
              />
            </div>
          }
          emptyState={
            <EmptyState
              icon={CalendarDays}
              title={t("admin.leaveBal.empty.title")}
              hint={
                employeeId !== null || leaveTypeId !== null || departmentName !== ALL_DEPARTMENTS
                  ? t("admin.leaveBal.empty.filtered")
                  : t("admin.leaveBal.empty.hint")
              }
            />
          }
        />
      </StateBoundary>
    </div>
  );
}
