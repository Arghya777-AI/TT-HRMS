/**
 * A-KIOSK-03 · /admin/kiosk/enrolment — the operational gap list (spec-admin §5.10,
 * view §9.3).
 *
 * `v_enrolment_coverage` already IS the queue: its predicate is
 * `(no active consent) OR (no active template)` over non-excluded active
 * employees, so an empty grid means full coverage rather than a failed read. The
 * screen therefore never filters the list down itself and never counts "who is
 * enrolled" — that denominator is not in the view and inventing it is how a
 * coverage figure starts disagreeing with the gate.
 *
 * The one product rule this screen must not get wrong (§5.10): a WITHDRAWN
 * consent is a distinct gap kind and is not a to-do. Those employees punch by
 * another method and are never chased. They are shown, tinted neutral, with the
 * reason said out loud — and they are excluded from the "needs action" tile.
 *
 * @route /admin/kiosk/enrolment
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ScanFace, ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { useFaceLoginAccess, useSetFaceLogin } from "../../settings/hooks/useFaceLogin";
import type { FaceLoginAccess } from "../../settings/api/faceLogin.api";
import { PersonCell } from "../components/PersonCell";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { fetchEmployeeOptions, type DirectoryRow } from "../api/employees.api";
import type { EnrolmentGap } from "../api/system.api";
import type { EnrolmentRequest } from "../api/kiosk.api";
import { useEnrolmentGaps, useEnrolmentRequests } from "../hooks/useKioskConsole";
import { FaceEnrolmentConsole } from "../components/FaceEnrolmentConsole";
import { gapChip, qualityChip, requestViaLabel } from "../kiosk-display";
import { KioskSectionNav } from "../components/KioskSectionNav";
import { KioskLinkCard } from "../components/KioskLinkCard";
import { asArray } from "@/lib/asArray";

type GapFilter = "all" | "no_consent" | "consented_not_enrolled" | "consent_withdrawn";

const FILTERS: readonly { key: GapFilter; label: string }[] = [
  { key: "all", label: t("admin.kiosk.enrolment.filter.all") },
  { key: "no_consent", label: t("admin.kiosk.enrolment.gap.no_consent") },
  { key: "consented_not_enrolled", label: t("admin.kiosk.enrolment.gap.consented_not_enrolled") },
  { key: "consent_withdrawn", label: t("admin.kiosk.enrolment.gap.consent_withdrawn") },
];

/**
 * The band the enrolment function itself uses (`quality_score >= 0.8` good,
 * `>= 0.55` fair). Mirrored here for `face_enrolment_requests.quality_score`,
 * which is a raw 0–1 column with no server-side band — the NUMBER is never
 * rendered, only the word.
 */
function requestQualityBand(score: number | null): string | null {
  if (score === null) return null;
  return score >= 0.8 ? "good" : score >= 0.55 ? "fair" : "poor";
}

export default function EnrolmentQueuePage() {
  const [filter, setFilter] = useState<GapFilter>("all");
  const gaps = useEnrolmentGaps();
  const requests = useEnrolmentRequests(true);

  const employees = useQuery({
    queryKey: qk.admin.employees({ scope: "enrolment-requests" }),
    queryFn: ({ signal }) => fetchEmployeeOptions({}, 300, signal),
    retry: shouldRetryQuery,
    enabled: asArray(requests.data).length > 0,
  });

  const employeeById = useMemo(() => {
    const map = new Map<string, DirectoryRow>();
    for (const row of asArray(employees.data)) map.set(row.id, row);
    return map;
  }, [employees.data]);

  const allGaps = useMemo(() => asArray(gaps.data), [gaps.data]);
  const noConsent = allGaps.filter((g) => g.gap_kind === "no_consent").length;
  const notEnrolled = allGaps.filter((g) => g.gap_kind === "consented_not_enrolled").length;
  const withdrawn = allGaps.filter((g) => g.gap_kind === "consent_withdrawn").length;

  const visible = useMemo(
    () => (filter === "all" ? allGaps : allGaps.filter((g) => g.gap_kind === filter)),
    [allGaps, filter],
  );

  const gapColumns: DataGridColumn<EnrolmentGap>[] = [
    {
      key: "employee",
      header: t("admin.kiosk.enrolment.col.employee"),
      sortable: true,
      sortValue: (row) => row.display_name,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.display_name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.employee_code}</span>
        </span>
      ),
    },
    {
      key: "department_name",
      header: t("admin.kiosk.enrolment.col.department"),
      hideBelow: "md",
      sortable: true,
      render: (row) => dash(row.department_name),
    },
    {
      key: "date_of_join",
      header: t("admin.kiosk.enrolment.col.joined"),
      hideBelow: "lg",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.date_of_join)}</span>,
    },
    {
      key: "gap_kind",
      header: t("admin.kiosk.enrolment.col.gap"),
      width: "14rem",
      render: (row) =>
        row.gap_kind === null ? (
          dash(null)
        ) : (
          <StatusChip status={row.gap_kind} map={gapChip(row.gap_kind)} />
        ),
    },
    {
      key: "consent_granted_at",
      header: t("admin.kiosk.enrolment.col.consent"),
      hideBelow: "md",
      render: (row) => dash(row.consent_granted_at, fmtDateTime),
    },
    {
      key: "has_active_template",
      header: t("admin.kiosk.enrolment.col.template"),
      width: "8rem",
      render: (row) =>
        row.has_active_template ? (
          <Badge variant="success">{t("admin.kiosk.enrolment.template.active")}</Badge>
        ) : (
          <Badge variant="neutral">{t("admin.kiosk.enrolment.template.none")}</Badge>
        ),
    },
  ];

  const requestColumns: DataGridColumn<EnrolmentRequest>[] = [
    {
      key: "employee",
      header: t("admin.kiosk.enrolment.requests.col.employee"),
      render: (row) => {
        const employee = employeeById.get(row.employee_id);
        if (employee === undefined) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{employee.display_name}</span>
            <span className="font-mono text-xs text-muted-foreground">{employee.employee_code}</span>
          </span>
        );
      },
    },
    {
      key: "requested_at",
      header: t("admin.kiosk.enrolment.requests.col.requested"),
      sortable: true,
      render: (row) => <span className="num">{fmtDateTime(row.requested_at)}</span>,
    },
    {
      key: "requested_via",
      header: t("admin.kiosk.enrolment.requests.col.via"),
      hideBelow: "md",
      render: (row) => requestViaLabel(row.requested_via),
    },
    {
      key: "quality_score",
      header: t("admin.kiosk.enrolment.requests.col.quality"),
      width: "9rem",
      // The band, never the score: a face-quality number is a similarity number.
      render: (row) => {
        const band = requestQualityBand(row.quality_score);
        return band === null ? dash(null) : <StatusChip status={band} map={qualityChip(band)} />;
      },
    },
    {
      key: "status",
      header: t("admin.kiosk.enrolment.requests.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} />,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScanFace}
        title={t("admin.kiosk.enrolment.title")}
        subtitle={t("admin.kiosk.enrolment.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/kiosk/templates">{t("admin.kiosk.templates.title")}</Link>
          </Button>
        }
      />

      <KioskSectionNav />

      {/*
        The gate link is here as well as on Devices, deliberately.

        This is the screen the rail lands on ("Face & kiosk"), so it is where
        somebody looking for the link will be standing. It was only on Devices,
        which had no rail entry and no inbound link from here — so the link existed
        and was, in practice, invisible. `KioskLinkCard` is self-contained and reads
        the origin from the browser, so rendering it twice costs nothing and cannot
        disagree with itself.
      */}
      <KioskLinkCard />

      {/*
       * The per-employee console. It supersedes the bare capture panel that used
       * to sit here: the capture is one of its actions, alongside consent, the
       * admin-initiated request, approval and revocation, and it is pointed at
       * ONE employee rather than at a second, independent employee picker.
       */}
      <div className="mt-4">
        <FaceEnrolmentConsole />
      </div>

      <StateBoundary
        loading={gaps.isLoading}
        error={gaps.error ?? undefined}
        onRetry={() => void gaps.refetch()}
        isEmpty={gaps.isSuccess && allGaps.length === 0}
        empty={
          <EmptyState
            icon={UserCheck}
            title={t("admin.kiosk.enrolment.empty.title")}
            hint={t("admin.kiosk.enrolment.empty.hint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/admin/kiosk/templates">{t("admin.kiosk.templates.title")}</Link>
              </Button>
            }
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            label={t("admin.kiosk.enrolment.kpi.gaps")}
            value={formatNumber(allGaps.length)}
            hint={t("admin.kiosk.enrolment.kpi.gapsHint")}
            tone={allGaps.length > 0 ? "warn" : "success"}
          />
          <KpiTile
            label={t("admin.kiosk.enrolment.kpi.noConsent")}
            value={formatNumber(noConsent)}
            tone={noConsent > 0 ? "warn" : "neutral"}
          />
          <KpiTile
            label={t("admin.kiosk.enrolment.kpi.notEnrolled")}
            value={formatNumber(notEnrolled)}
            tone={notEnrolled > 0 ? "info" : "neutral"}
          />
          <KpiTile
            label={t("admin.kiosk.enrolment.kpi.withdrawn")}
            value={formatNumber(withdrawn)}
            tone="neutral"
            hint={t("admin.kiosk.enrolment.withdrawnNote")}
          />
        </section>

        <p className="mb-3 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("admin.kiosk.enrolment.withdrawnNote")}
        </p>

        <DataGrid
          columns={gapColumns}
          rows={visible}
          rowKey={(row) => row.employee_id}
          pageSize={25}
          toolbar={
            <div className="flex flex-wrap gap-1" role="group">
              {FILTERS.map((f) => (
                <Button
                  key={f.key}
                  size="sm"
                  variant={filter === f.key ? "default" : "outline"}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          }
          emptyState={
            <EmptyState
              icon={UserCheck}
              title={t("admin.kiosk.enrolment.emptyFiltered.title")}
              hint={t("admin.kiosk.enrolment.emptyFiltered.hint")}
              action={
                <Button variant="outline" onClick={() => setFilter("all")}>
                  {t("admin.kiosk.enrolment.filter.all")}
                </Button>
              }
            />
          }
        />
      </StateBoundary>

      <h2 className="mb-3 mt-8 font-display text-lg font-semibold">
        {t("admin.kiosk.enrolment.requests.title")}
      </h2>

      <StateBoundary
        loading={requests.isLoading}
        error={requests.error ?? undefined}
        onRetry={() => void requests.refetch()}
        partialError={employees.error ?? undefined}
        partialLabel={t("admin.kiosk.enrolment.requests.col.employee")}
        skeletonRows={3}
      >
        <DataGrid
          columns={requestColumns}
          rows={asArray(requests.data)}
          rowKey={(row) => row.id}
          pageSize={10}
          emptyState={
            <EmptyState
              icon={ScanFace}
              title={t("admin.kiosk.enrolment.requests.empty.title")}
              hint={t("admin.kiosk.enrolment.requests.empty.hint")}
            />
          }
        />
        <p className="mt-3 text-xs text-muted-foreground">
          <Link className="underline underline-offset-4" to="/admin/kiosk/templates">
            {t("admin.kiosk.enrolment.requests.review")}
          </Link>
        </p>
      </StateBoundary>

      <FaceLoginRoster />
    </div>
  );
}

/**
 * Who may sign in with their face, for everybody in the admin's scope.
 *
 * The enrolment console is the right home for it: this is where an admin already
 * decides who has a face template at all, and "may that template open a session" is
 * the next question in the same breath.
 *
 * SCOPE IS THE VIEW'S, NOT THIS COMPONENT'S. `useFaceLoginAccess()` with no argument
 * returns every row `v_face_login_access` permits — for an admin, their whole scope;
 * for a manager who somehow reached this screen, only their team. Nothing here filters
 * by role, so the list cannot be wider than the caller's authority.
 */
function FaceLoginRoster() {
  const access = useFaceLoginAccess();
  const rows = asArray(access.data);

  const columns: DataGridColumn<FaceLoginAccess>[] = [
    {
      key: "display_name",
      header: t("faceLogin.admin.col.person"),
      width: "16rem",
      render: (row) => (
        <PersonCell name={row.display_name ?? "—"} code={row.employee_code ?? ""} />
      ),
    },
    {
      key: "allow_face_login",
      header: t("faceLogin.admin.col.state"),
      width: "10rem",
      render: (row) => (
        <StatusChip
          status={row.allow_face_login ? "on" : "off"}
          map={{
            on: { label: t("faceLogin.state.on"), tone: "success" },
            off: { label: t("faceLogin.state.off"), tone: "neutral" },
          }}
        />
      ),
    },
    {
      key: "has_live_template",
      header: t("faceLogin.admin.col.enrolled"),
      width: "14rem",
      hideBelow: "md",
      /*
        The enrolment state ALWAYS shows, with the privileged note added beneath it when
        it applies. It used to show the privileged label INSTEAD, which hid whether the
        person was enrolled at all — and now that a privileged account CAN sign in by
        face, at a stricter match, that omission would mislead an admin trying to work
        out why somebody cannot get in.
      */
      render: (row) => (
        <div className="min-w-0">
          {row.has_live_template ? (
            <span className="text-sm">{t("faceLogin.admin.template.live")}</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {row.has_enrolled
                ? t("faceLogin.admin.template.gone")
                : t("faceLogin.admin.template.none")}
            </span>
          )}
          {row.is_privileged ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("faceLogin.admin.privileged")}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "action",
      header: t("faceLogin.admin.col.action"),
      align: "right",
      width: "13rem",
      render: (row) => <FaceLoginRowAction row={row} />,
    },
  ];

  return (
    <div className="mt-8">
      <h2 className="font-display text-lg font-semibold">{t("faceLogin.admin.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("faceLogin.admin.hint")}</p>
      <div className="mt-3">
        <StateBoundary
          loading={access.isPending}
          error={access.error}
          onRetry={() => void access.refetch()}
          isEmpty={!access.isPending && access.error === null && rows.length === 0}
          empty={<EmptyState icon={ScanFace} title={t("faceLogin.admin.empty")} />}
          skeletonRows={4}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.employee_id} pageSize={15} />
        </StateBoundary>
      </div>
    </div>
  );
}

/**
 * One row's button. Its own component so the pending state of one person's toggle
 * cannot re-render, or disable, the whole table.
 */
function FaceLoginRowAction({ row }: { row: FaceLoginAccess }) {
  const set = useSetFaceLogin();
  if (!row.can_manage) {
    return <span className="text-xs text-muted-foreground">{t("faceLogin.noPermission")}</span>;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={row.allow_face_login ? "outline" : "default"}
      disabled={set.isPending}
      onClick={() =>
        set.mutate({ employeeId: row.employee_id, enabled: !row.allow_face_login })
      }
    >
      {row.allow_face_login ? t("faceLogin.action.disable") : t("faceLogin.action.enable")}
    </Button>
  );
}
