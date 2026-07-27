/**
 * /team/people — My Team. Every reportee, direct AND indirect, with the
 * reporting depth stated so an indirect report is visibly indirect.
 *
 * WHAT MAKES THIS SCREEN CORRECT
 * ------------------------------
 *  1. MANAGERSHIP IS DERIVED. There is no manager role and no manager column to
 *     grant. This list is the recursive reporting closure
 *     (`analytics.mv_team_hierarchy` behind `v_team_hierarchy`), and the view's
 *     own predicate is what decides whose edges the caller may read. The
 *     `manager_employee_id` filter this page passes is a CORRECTNESS filter, not
 *     a security one: the view legitimately serves BOTH directions (edges where
 *     the caller is the manager, and the caller's own upward chain), so reading
 *     it unfiltered would list the manager as a member of their own team. Asking
 *     for somebody else's id simply returns nothing.
 *
 *  2. A MANAGER SEES LESS THAN AN ADMIN, DELIBERATELY. Every column here comes
 *     from `v_team_employee_basic`, which IS the manager column allow-list: no
 *     salary, no PAN/Aadhaar, no bank, no home address, no dependents, and a
 *     birthday rendered as day+month with no year. There is no "show more" and
 *     no reveal control, because there is nothing withheld behind one — the
 *     columns are absent from the view, not masked in it.
 *
 *  3. THE TOTAL IS POSTGRES'S. The header count is a `count=exact` over
 *     `v_team_hierarchy` using the SAME filter array as the list, so it cannot
 *     drift from the rows (DR-29). `rows.length` is not the total anywhere.
 *
 *  4. IT ADMITS ITS OWN AGE. The closure is materialised and refreshed on a
 *     schedule, so `refreshed_at` is a real fact about this screen and is
 *     printed as "as of … IST" (§9.4). A reorganisation half an hour ago is not
 *     on this list yet, and the screen says so instead of implying it is live.
 *
 * The list is assembled from two reads — the edges (depth) and the key facts —
 * joined by employee id. That is a LABEL join, not arithmetic: no figure on this
 * screen is derived from another.
 *
 * @route /team/people
 */
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { UserCog, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "@/features/admin/components/PersonCell";
import { Notice } from "@/features/admin/components/Notice";
import {
  useMyEmployeeId,
  useShiftMap,
  useTeamEdgeCount,
  useTeamEdges,
  useTeamMembers,
} from "../hooks/useTeamToday";
import {
  EMPLOYMENT_STATUS_CHIP,
  EMPLOYMENT_TYPE_LABELS,
  type TeamMember,
} from "../api/team.api";

/** One grid row: the reporting edge plus the facts the allow-list permits. */
interface TeamPersonRow {
  readonly employeeId: string;
  readonly depth: number;
  readonly isDirect: boolean;
  /** Absent when the closure names somebody the allow-list did not return. */
  readonly member: TeamMember | undefined;
}

export default function TeamPeoplePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const myEmployeeId = useMyEmployeeId();

  const directOnly = params.get("depth") === "direct";

  const edges = useTeamEdges(myEmployeeId, directOnly);
  const total = useTeamEdgeCount(myEmployeeId, directOnly);

  // Memoised, not `edges.data ?? []` inline: a fresh `[]` on every render would
  // re-run both memos below and rebuild every row object each time.
  const edgeRows = useMemo(() => edges.data ?? [], [edges.data]);
  const memberIds = useMemo(() => edgeRows.map((e) => e.employee_id), [edgeRows]);
  const members = useTeamMembers(memberIds);

  const memberById = useMemo(() => {
    const m = new Map<string, TeamMember>();
    for (const row of members.data ?? []) m.set(row.id, row);
    return m;
  }, [members.data]);

  /** id → display name, so "Reports to" is never a uuid on screen. */
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of members.data ?? []) m.set(row.id, row.display_name);
    return m;
  }, [members.data]);

  const shiftIds = useMemo(
    () =>
      (members.data ?? [])
        .map((row) => row.shift_id)
        .filter((id): id is string => id !== null),
    [members.data],
  );
  const shifts = useShiftMap(shiftIds);

  const rows = useMemo<TeamPersonRow[]>(
    () =>
      edgeRows.map((edge) => ({
        employeeId: edge.employee_id,
        depth: edge.depth,
        isDirect: edge.is_direct,
        member: memberById.get(edge.employee_id),
      })),
    [edgeRows, memberById],
  );

  /**
   * The closure returned an edge whose person the allow-list did not. The two
   * relations are refreshed independently, so this is a real (if rare) state:
   * somebody left the organisation since the last matview refresh. It is shown
   * as a partial, never silently dropped.
   */
  const hasUnresolved = rows.some((r) => r.member === undefined);

  const refreshedAt = edgeRows[0]?.refreshed_at ?? null;

  const setDepth = (next: "direct" | "all") => {
    const nextParams = new URLSearchParams(params);
    if (next === "all") nextParams.delete("depth");
    else nextParams.set("depth", "direct");
    setParams(nextParams, { replace: true });
  };

  const columns: DataGridColumn<TeamPersonRow>[] = [
    {
      key: "display_name",
      header: t("team.people.col.employee"),
      width: "16rem",
      sortable: true,
      sortValue: (r) => r.member?.display_name ?? "",
      render: (r) => (
        <PersonCell
          name={r.member?.display_name ?? null}
          code={r.member?.employee_code ?? null}
          secondary={r.member?.designation_name ?? null}
        />
      ),
    },
    {
      key: "depth",
      header: t("team.people.col.reporting"),
      width: "11rem",
      sortable: true,
      sortValue: (r) => r.depth,
      // `depth` and `is_direct` are matview columns. The label states the level
      // in words so "indirect" is never something the reader has to infer.
      render: (r) =>
        r.isDirect ? (
          <span className="text-sm font-medium">{t("team.people.depth.direct")}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{t("team.people.depth.indirect")}</span>
            <span className="num text-xs text-muted-foreground">
              {t("team.people.depth.levels", { n: formatNumber(r.depth) })}
            </span>
          </span>
        ),
    },
    {
      key: "reporting_manager_id",
      header: t("team.people.col.reportsTo"),
      width: "12rem",
      hideBelow: "md",
      render: (r) => {
        const managerId = r.member?.reporting_manager_id ?? null;
        if (managerId === null) return dash(null);
        // Only resolvable inside the caller's own team. Outside it, the honest
        // render is an em dash — never the uuid (DR-53 class).
        return dash(nameById.get(managerId) ?? null);
      },
    },
    {
      key: "department_name",
      header: t("team.people.col.department"),
      hideBelow: "md",
      render: (r) => dash(r.member?.department_name ?? null),
    },
    {
      key: "section_name",
      header: t("team.people.col.section"),
      hideBelow: "lg",
      render: (r) => dash(r.member?.section_name ?? null),
    },
    {
      key: "location_name",
      header: t("team.people.col.location"),
      hideBelow: "lg",
      render: (r) => dash(r.member?.location_name ?? null),
    },
    {
      key: "employment_status",
      header: t("team.people.col.status"),
      width: "9rem",
      render: (r) => {
        const status = r.member?.employment_status;
        if (status === undefined) return dash(null);
        return <StatusChip status={status} map={EMPLOYMENT_STATUS_CHIP} />;
      },
    },
    {
      key: "employment_type",
      header: t("team.people.col.type"),
      hideBelow: "lg",
      render: (r) => {
        const type = r.member?.employment_type;
        return dash(type === undefined ? null : EMPLOYMENT_TYPE_LABELS[type]);
      },
    },
    {
      key: "shift_id",
      header: t("team.people.col.shift"),
      width: "7rem",
      hideBelow: "md",
      // The shift CODE. `display_label` is "G — 09:30 AM to 06:30 PM" and a
      // 12-hour clock is banned app-wide (DR-53).
      render: (r) => {
        const shiftId = r.member?.shift_id ?? null;
        if (shiftId === null) return dash(null);
        return dash(shifts.map.get(shiftId)?.code ?? null);
      },
    },
    {
      key: "date_of_join",
      header: t("team.people.col.joined"),
      width: "9rem",
      align: "right",
      sortable: true,
      sortValue: (r) => r.member?.date_of_join ?? "",
      render: (r) => <span className="num">{fmtCivilDate(r.member?.date_of_join ?? null)}</span>,
    },
    {
      key: "is_face_enrolled",
      header: t("team.people.col.gate"),
      width: "9rem",
      hideBelow: "lg",
      render: (r) => {
        const enrolled = r.member?.is_face_enrolled;
        if (enrolled === undefined) return dash(null);
        return enrolled ? (
          <span className="text-sm text-success">{t("team.people.gate.ready")}</span>
        ) : (
          <span className="text-sm text-warning">{t("team.people.gate.notEnrolled")}</span>
        );
      },
    },
  ];

  const subtitle = total.isSuccess
    ? directOnly
      ? t("team.people.subtitle.direct", { n: formatNumber(total.data) })
      : t("team.people.subtitle.all", { n: formatNumber(total.data) })
    : t("team.people.subtitle.plain");

  if (myEmployeeId === null) {
    return (
      <div className="container py-6">
        <PageHeader
          icon={UserCog}
          title={t("team.people.title")}
          subtitle={t("team.people.subtitle.plain")}
        />
        <EmptyState
          icon={Users}
          title={t("team.people.noRecord.title")}
          hint={t("team.people.noRecord.hint")}
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserCog}
        title={t("team.people.title")}
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={directOnly ? "default" : "outline"}
              size="sm"
              aria-pressed={directOnly}
              onClick={() => setDepth("direct")}
            >
              {t("team.people.filter.directOnly")}
            </Button>
            <Button
              variant={directOnly ? "outline" : "default"}
              size="sm"
              aria-pressed={!directOnly}
              onClick={() => setDepth("all")}
            >
              {t("team.people.filter.everyone")}
            </Button>
          </div>
        }
      />

      {refreshedAt !== null ? (
        <p className="num mb-3 text-xs text-muted-foreground">
          {t("team.people.asOf", { when: fmtDateTime(refreshedAt) })}
        </p>
      ) : null}

      <StateBoundary
        loading={edges.isPending}
        error={edges.error}
        onRetry={() => void edges.refetch()}
        isEmpty={rows.length === 0}
        partialError={total.error ?? members.error ?? shifts.error}
        partialLabel={t("team.people.partial.label")}
        empty={
          directOnly ? (
            <EmptyState
              icon={Users}
              title={t("team.people.empty.direct.title")}
              hint={t("team.people.empty.direct.hint")}
              action={
                <Button variant="outline" onClick={() => setDepth("all")}>
                  {t("team.people.filter.everyone")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title={t("team.people.empty.title")}
              hint={t("team.people.empty.hint")}
            />
          )
        }
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => r.employeeId}
          pageSize={25}
          onRowClick={(r) => {
            const code = r.member?.employee_code;
            if (code !== undefined) void navigate(`/team/people/${code}`);
          }}
        />
      </StateBoundary>

      <div className="mt-4 space-y-3">
        {hasUnresolved ? <Notice tone="warning">{t("team.people.unresolved")}</Notice> : null}
        <Notice tone="info">{t("team.people.footnote.derived")}</Notice>
        <Notice tone="info">{t("team.people.footnote.lessThanAdmin")}</Notice>
      </div>
    </div>
  );
}
