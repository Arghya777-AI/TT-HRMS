/**
 * §14 · /admin/analytics/compliance — Compliance Analytics. Required-document
 * expiry, and biometric enrolment / consent coverage.
 *
 * Two relations, two very different shapes, and the difference is the whole
 * design of this screen:
 *
 *  1. `v_document_compliance` is COMPLETE. It has one row per employee ×
 *     required document type with the server's own `compliance_status` verdict
 *     ('missing' | 'expired' | 'expiring_soon' | 'valid'), so it can answer both
 *     "how many are wrong" and "out of how many". Each tile is one
 *     `count=exact` with the same predicate as the grid it filters to, and the
 *     60-day window on `expiring_soon` is the VIEW's, not ours — the label says
 *     60 days because the SQL says 60 days.
 *  2. `v_enrolment_coverage` is INCOMPLETE BY DESIGN. Its predicate is
 *     `(no active consent OR no active template)`, so a fully enrolled employee
 *     is simply not in it. It can therefore count GAPS but can never produce a
 *     coverage percentage, and this screen does not manufacture one by dividing
 *     gaps by a headcount taken from a different relation with a different
 *     predicate (different exclusions, different status set). The gap is named on
 *     the page instead of being papered over — see the notice at the foot.
 *
 * A withdrawn consent is shown as a distinct, NEUTRAL gap kind (§5.10): the
 * employee made a lawful choice and uses the alternative punch method. It is not
 * a problem to chase, and it is never toned as an error.
 *
 * @route /admin/analytics/compliance
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileWarning, ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import { PersonCell } from "../components/PersonCell";
import { RankedBarsChart, type ChartPoint, type ChartSeries } from "../components/AnalyticsOpsCharts";
import { useRefOptions } from "../hooks/useMasters";
import {
  useComplianceStatusCounts,
  useDocumentComplianceCount,
  useDocumentExpiry,
  useEnrolmentCoverage,
  useEnrolmentGapCounts,
} from "../hooks/useAnalyticsOps";
import {
  COMPLIANCE_STATUSES,
  ENROLMENT_GAP_KINDS,
  type DocumentExpiryRow,
  type EnrolmentCoverageRow,
} from "../api/analytics-ops.api";
import { DOCUMENT_EXPIRY_WINDOW_DAYS } from "../api/command.api";
import { gapChip } from "../kiosk-display";

/** The view's `expiring_soon` window, in days. Named by the server, not us. */
const EXPIRY_WINDOW = DOCUMENT_EXPIRY_WINDOW_DAYS;

const COMPLIANCE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  missing: { label: t("admin.acomp.status.missing"), tone: "danger" },
  expired: { label: t("admin.acomp.status.expired"), tone: "danger" },
  expiring_soon: { label: t("admin.acomp.status.expiringSoon"), tone: "warn" },
  valid: { label: t("admin.acomp.status.valid"), tone: "success" },
};

const STATUS_TONE: Readonly<Record<string, "success" | "warn" | "danger" | "info" | "neutral">> = {
  missing: "danger",
  expired: "danger",
  expiring_soon: "warn",
  valid: "success",
};

const GAP_MEASURE: ChartSeries = { key: "n", label: t("admin.acomp.series.documents") };

/** The statuses that need action, in the order an administrator works them. */
const ACTIONABLE = ["expired", "expiring_soon", "missing"] as const;

function isComplianceStatus(value: string): boolean {
  return (COMPLIANCE_STATUSES as readonly string[]).includes(value);
}

export default function AnalyticsCompliancePage() {
  const [params, setParams] = useSearchParams();

  const departmentId = params.get("department") ?? "";
  const statusParam = params.get("status") ?? "";
  const status = isComplianceStatus(statusParam) ? statusParam : "";
  const gapParam = params.get("gap") ?? "";
  const gapKind = (ENROLMENT_GAP_KINDS as readonly string[]).includes(gapParam) ? gapParam : "";

  const departments = useRefOptions("departments");
  const departmentIds = useMemo(
    () => (departmentId !== "" ? [departmentId] : undefined),
    [departmentId],
  );

  const docFilters = useMemo(
    () => ({
      ...(status !== "" ? { statuses: [status] } : { statuses: [...ACTIONABLE] }),
      ...(departmentIds !== undefined ? { departmentIds } : {}),
    }),
    [status, departmentIds],
  );

  const statusCounts = useComplianceStatusCounts(COMPLIANCE_STATUSES, departmentIds);
  const gapCounts = useEnrolmentGapCounts(ENROLMENT_GAP_KINDS, departmentIds);
  const docRows = useDocumentExpiry(docFilters);
  const docCount = useDocumentComplianceCount(docFilters);

  const coverageFilters = useMemo(
    () => ({
      ...(gapKind !== "" ? { gapKinds: [gapKind] } : {}),
      ...(departmentIds !== undefined ? { departmentIds } : {}),
    }),
    [gapKind, departmentIds],
  );
  const coverage = useEnrolmentCoverage(coverageFilters);

  /** Server counts, one bar each — a chart of four HEAD requests, not a group-by. */
  const statusPoints: readonly ChartPoint[] = useMemo(
    () =>
      statusCounts.map((bucket) => ({
        x: COMPLIANCE_CHIP[bucket.status]?.label ?? bucket.status,
        values: { n: bucket.count ?? null },
      })),
    [statusCounts],
  );

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  const docColumns: DataGridColumn<DocumentExpiryRow>[] = useMemo(
    () => [
      {
        key: "display_name",
        header: t("admin.acomp.col.employee"),
        width: "15rem",
        sortable: true,
        render: (row) => (
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.department_name}
          />
        ),
      },
      {
        key: "document_type_name",
        header: t("admin.acomp.col.documentType"),
        width: "14rem",
        sortable: true,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{row.document_type_name}</span>
            <span className="num text-xs text-muted-foreground">{row.document_type_code}</span>
          </span>
        ),
      },
      {
        key: "compliance_status",
        header: t("admin.acomp.col.status"),
        width: "10rem",
        sortable: true,
        render: (row) => <StatusChip status={row.compliance_status} map={COMPLIANCE_CHIP} />,
      },
      {
        key: "expiry_date",
        header: t("admin.acomp.col.expiry"),
        width: "10rem",
        align: "right",
        sortable: true,
        render: (row) => <span className="num">{fmtCivilDate(row.expiry_date)}</span>,
      },
      {
        key: "requires_expiry",
        header: t("admin.acomp.col.requiresExpiry"),
        width: "8rem",
        hideBelow: "lg",
        render: (row) =>
          row.requires_expiry ? t("admin.acomp.yes") : t("admin.acomp.no"),
      },
      {
        key: "document_status",
        header: t("admin.acomp.col.docStatus"),
        width: "10rem",
        hideBelow: "lg",
        render: (row) =>
          row.document_status === null ? (
            <span className="text-xs text-muted-foreground">{t("admin.acomp.notUploaded")}</span>
          ) : (
            <StatusChip status={row.document_status} />
          ),
      },
    ],
    [],
  );

  const coverageColumns: DataGridColumn<EnrolmentCoverageRow>[] = useMemo(
    () => [
      {
        key: "display_name",
        header: t("admin.acomp.col.employee"),
        width: "15rem",
        sortable: true,
        render: (row) => (
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.department_name}
          />
        ),
      },
      {
        key: "gap_kind",
        header: t("admin.acomp.col.gap"),
        width: "13rem",
        sortable: true,
        render: (row) =>
          row.gap_kind === null ? (
            dash(null)
          ) : (
            <StatusChip status={row.gap_kind} map={gapChip(row.gap_kind)} />
          ),
      },
      {
        key: "has_active_consent",
        header: t("admin.acomp.col.consent"),
        width: "9rem",
        render: (row) => (row.has_active_consent ? t("admin.acomp.yes") : t("admin.acomp.no")),
      },
      {
        key: "has_active_template",
        header: t("admin.acomp.col.template"),
        width: "9rem",
        render: (row) => (row.has_active_template ? t("admin.acomp.yes") : t("admin.acomp.no")),
      },
      {
        key: "date_of_join",
        header: t("admin.acomp.col.joined"),
        width: "10rem",
        align: "right",
        sortable: true,
        hideBelow: "md",
        render: (row) => <span className="num">{fmtCivilDate(row.date_of_join)}</span>,
      },
    ],
    [],
  );

  const docsShown = docRows.data ?? [];
  const coverageShown = coverage.data ?? [];
  const anyFilter = departmentId !== "" || status !== "" || gapKind !== "";

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.acomp.title")}
        subtitle={t("admin.acomp.subtitle", { days: formatNumber(EXPIRY_WINDOW) })}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/audit/dpdp">{t("admin.acomp.toDpdp")}</Link>
          </Button>
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.acomp.filter.department")}
          value={departmentId}
          placeholder={t("admin.acomp.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <SelectField
          label={t("admin.acomp.filter.status")}
          value={status}
          placeholder={t("admin.acomp.filter.actionable")}
          options={COMPLIANCE_STATUSES.map((s) => ({
            value: s,
            label: COMPLIANCE_CHIP[s]?.label ?? s,
          }))}
          onChange={(v) => setParam("status", v)}
          hint={t("admin.acomp.filter.statusHint")}
        />
        <div className="flex items-end justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {docCount.isSuccess
              ? t("admin.acomp.rowCount", { n: formatNumber(docCount.data) })
              : t("admin.acomp.rowCountUnknown")}
          </p>
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.acomp.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Document compliance — one count=exact per status arm. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {statusCounts.map((bucket) => (
          <KpiTile
            key={bucket.status}
            label={COMPLIANCE_CHIP[bucket.status]?.label ?? bucket.status}
            value={
              bucket.isPending ? "…" : bucket.error !== null ? dash(null) : formatNumber(bucket.count)
            }
            tone={STATUS_TONE[bucket.status] ?? "neutral"}
            hint={
              bucket.status === "expiring_soon"
                ? t("admin.acomp.kpi.expiringHint", { days: formatNumber(EXPIRY_WINDOW) })
                : t("admin.acomp.kpi.docHint")
            }
            explainer={{
              formula: t("admin.acomp.kpi.docFormula", { status: bucket.status }),
              numbers: t("admin.acomp.kpi.docNumbers"),
            }}
          />
        ))}
      </div>

      <div className="mt-4 rounded-lg border bg-card p-4">
        <StateBoundary
          loading={statusCounts.some((b) => b.isPending)}
          error={statusCounts.find((b) => b.error !== null)?.error ?? undefined}
          isEmpty={statusPoints.length === 0}
          skeletonRows={3}
          empty={
            <EmptyState
              icon={FileWarning}
              title={t("admin.acomp.chart.empty.title")}
              hint={t("admin.acomp.chart.empty.hint")}
            />
          }
        >
          <RankedBarsChart
            title={t("admin.acomp.chart.title")}
            caption={t("admin.acomp.chart.caption")}
            measure={GAP_MEASURE}
            points={statusPoints}
            format={(v) => (v === null ? dash(null) : formatNumber(v))}
            xHeader={t("admin.acomp.col.status")}
            labelWidth={132}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <h2 className="font-display text-lg font-semibold">{t("admin.acomp.docs.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.acomp.docs.hint", { days: formatNumber(EXPIRY_WINDOW) })}
        </p>
        <div className="mt-3">
          <StateBoundary
            loading={docRows.isPending}
            error={docRows.error}
            onRetry={() => void docRows.refetch()}
            isEmpty={docsShown.length === 0}
            empty={
              <EmptyState
                icon={FileWarning}
                title={t("admin.acomp.docs.empty.title")}
                hint={t("admin.acomp.docs.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={docColumns}
              rows={docsShown}
              rowKey={(row) => `${row.employee_id}:${row.document_type_id}`}
              pageSize={25}
            />
          </StateBoundary>
        </div>
      </div>

      {/* Enrolment & consent coverage — gap counts only, and the page says why. */}
      <div className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.acomp.gaps.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.acomp.gaps.hint")}</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {gapCounts.map((bucket) => {
            const chip = gapChip(bucket.status)[bucket.status];
            const active = gapKind === bucket.status;
            return (
              <KpiTile
                key={bucket.status}
                label={chip?.label ?? bucket.status}
                value={
                  bucket.isPending
                    ? "…"
                    : bucket.error !== null
                      ? dash(null)
                      : formatNumber(bucket.count)
                }
                tone={chip?.tone ?? "neutral"}
                hint={active ? t("admin.acomp.gaps.filtered") : t("admin.acomp.gaps.tileHint")}
                explainer={{
                  formula: t("admin.acomp.gaps.formula", { kind: bucket.status }),
                  numbers: t("admin.acomp.gaps.numbers"),
                }}
              />
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {ENROLMENT_GAP_KINDS.map((kind) => (
            <Button
              key={kind}
              variant={gapKind === kind ? "default" : "outline"}
              size="sm"
              onClick={() => setParam("gap", gapKind === kind ? "" : kind)}
            >
              {gapChip(kind)[kind]?.label ?? kind}
            </Button>
          ))}
        </div>

        <div className="mt-3">
          <StateBoundary
            loading={coverage.isPending}
            error={coverage.error}
            onRetry={() => void coverage.refetch()}
            isEmpty={coverageShown.length === 0}
            empty={
              <EmptyState
                icon={UserCheck}
                title={t("admin.acomp.gaps.empty.title")}
                hint={t("admin.acomp.gaps.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={coverageColumns}
              rows={coverageShown}
              rowKey={(row) => row.employee_id}
              pageSize={25}
            />
          </StateBoundary>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.acomp.note.window", { days: formatNumber(EXPIRY_WINDOW) })}</Notice>
        <Notice tone="warning">{t("admin.acomp.note.noCoverageRatio")}</Notice>
        <Notice tone="warning">{t("admin.acomp.note.noStatutoryView")}</Notice>
      </div>
    </div>
  );
}
