/**
 * A-KIOSK-06 · /admin/kiosk/consent — the DPDP consent register (spec-admin
 * §5.10, D-19).
 *
 * HONEST LIMITATION, stated on the screen as well as here: there is no consent
 * VIEW. `secure.biometric_consents` has zero grants to `authenticated`, and the
 * two admin-readable relations each carry only half the register:
 *
 *   * `v_enrolment_coverage` — employees missing consent or a template, with
 *     `consent_granted_at` and a `consent_withdrawn` flag. Its predicate excludes
 *     anyone who already has both, so it can never list a consenting, enrolled
 *     employee.
 *   * `face-template-admin` (list, state=all) — per-template `consent.grantedAt`
 *     and `consent.withdrawnAt`, which covers exactly the employees the coverage
 *     view drops.
 *
 * The register is the UNION of the two, keyed by employee, and the banner says
 * so. Assembling it here is a join, not a computation: no date is derived and no
 * count is inferred — an employee who appears in neither source is reported as
 * absent rather than assumed to have consented.
 *
 * @route /admin/kiosk/consent
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useEnrolmentGaps, useFaceTemplates } from "../hooks/useKioskConsole";
import { consentChip, type ConsentStatus } from "../kiosk-display";
import { KioskSectionNav } from "../components/KioskSectionNav";

interface ConsentRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly status: ConsentStatus;
  readonly grantedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly noticeVersion: string | null;
  readonly template: "active" | "retired" | "none";
}

type ConsentFilter = "all" | ConsentStatus;

const FILTERS: readonly { key: ConsentFilter; label: string }[] = [
  { key: "all", label: t("admin.kiosk.consent.filter.all") },
  { key: "granted", label: t("admin.kiosk.consent.status.granted") },
  { key: "withdrawn", label: t("admin.kiosk.consent.status.withdrawn") },
  { key: "none", label: t("admin.kiosk.consent.status.none") },
];

export default function ConsentRegisterPage() {
  const [filter, setFilter] = useState<ConsentFilter>("all");
  // Template metadata is an audited biometric read, so it is opt-in here too.
  const [withTemplates, setWithTemplates] = useState(false);

  const gaps = useEnrolmentGaps();
  const templates = useFaceTemplates("all", 0, withTemplates);

  const rows: ConsentRow[] = useMemo(() => {
    const byEmployee = new Map<string, ConsentRow>();

    // 1. Template metadata: the only source that carries a notice version and a
    //    withdrawal timestamp for an employee who IS enrolled.
    for (const tpl of templates.data?.templates ?? []) {
      const existing = byEmployee.get(tpl.employeeId);
      const status: ConsentStatus =
        tpl.consent.withdrawnAt !== null
          ? "withdrawn"
          : tpl.consent.grantedAt !== null
            ? "granted"
            : "none";
      const template = tpl.state === "active" ? "active" : "retired";
      // Keep the ACTIVE template's consent row when an employee has several
      // versions; otherwise the newest row already in hand.
      if (existing !== undefined && existing.template === "active" && template !== "active") continue;
      byEmployee.set(tpl.employeeId, {
        employeeId: tpl.employeeId,
        employeeCode: tpl.employeeCode,
        displayName: tpl.displayName ?? tpl.employeeCode,
        status,
        grantedAt: tpl.consent.grantedAt,
        withdrawnAt: tpl.consent.withdrawnAt,
        noticeVersion: tpl.consent.version,
        template,
      });
    }

    // 2. Coverage gaps: employees with no template at all, or a withdrawal the
    //    template rows cannot show because there is no template to hang it on.
    for (const gap of gaps.data ?? []) {
      if (byEmployee.has(gap.employee_id)) continue;
      const status: ConsentStatus = gap.consent_withdrawn
        ? "withdrawn"
        : gap.has_active_consent
          ? "granted"
          : "none";
      byEmployee.set(gap.employee_id, {
        employeeId: gap.employee_id,
        employeeCode: gap.employee_code,
        displayName: gap.display_name,
        status,
        grantedAt: gap.consent_granted_at,
        // v_enrolment_coverage exposes the FLAG, not the date.
        withdrawnAt: null,
        noticeVersion: null,
        template: gap.has_active_template ? "active" : "none",
      });
    }

    return [...byEmployee.values()].sort((a, b) => a.employeeCode.localeCompare(b.employeeCode, "en-IN"));
  }, [templates.data, gaps.data]);

  const granted = rows.filter((r) => r.status === "granted").length;
  const withdrawn = rows.filter((r) => r.status === "withdrawn").length;
  const missing = rows.filter((r) => r.status === "none").length;

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  const columns: DataGridColumn<ConsentRow>[] = [
    {
      key: "employee",
      header: t("admin.kiosk.consent.col.employee"),
      sortable: true,
      sortValue: (row) => row.employeeCode,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.displayName}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.employeeCode}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("admin.kiosk.consent.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={consentChip(row.status)} />,
    },
    {
      key: "grantedAt",
      header: t("admin.kiosk.consent.col.granted"),
      hideBelow: "md",
      render: (row) => dash(row.grantedAt, fmtDateTime),
    },
    {
      key: "withdrawnAt",
      header: t("admin.kiosk.consent.col.withdrawn"),
      hideBelow: "md",
      render: (row) => dash(row.withdrawnAt, fmtDateTime),
    },
    {
      key: "noticeVersion",
      header: t("admin.kiosk.consent.col.notice"),
      hideBelow: "lg",
      render: (row) => dash(row.noticeVersion),
    },
    {
      key: "template",
      header: t("admin.kiosk.consent.col.template"),
      width: "9rem",
      render: (row) =>
        row.template === "active" ? (
          <Badge variant="success">{t("admin.kiosk.consent.template.active")}</Badge>
        ) : row.template === "retired" ? (
          <Badge variant="neutral">{t("admin.kiosk.consent.template.retired")}</Badge>
        ) : (
          <Badge variant="warning">{t("admin.kiosk.consent.template.none")}</Badge>
        ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.kiosk.consent.title")}
        subtitle={t("admin.kiosk.consent.subtitle")}
        actions={
          withTemplates ? undefined : (
            <Button variant="outline" onClick={() => setWithTemplates(true)}>
              {t("admin.kiosk.consent.load")}
            </Button>
          )
        }
      />

      <KioskSectionNav />

      <p className="mb-3 flex items-start gap-2 rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
        {t("admin.kiosk.consent.dpdp")}
      </p>

      <p className="mb-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-medium text-foreground">
            {t("admin.kiosk.consent.sources.title")}
          </strong>{" "}
          {t("admin.kiosk.consent.sources.hint")}
        </span>
      </p>

      <StateBoundary
        loading={gaps.isLoading}
        error={gaps.error ?? undefined}
        onRetry={() => void gaps.refetch()}
        partialError={templates.error ?? undefined}
        partialLabel={t("admin.kiosk.consent.col.notice")}
        isEmpty={gaps.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={ShieldCheck}
            title={t("admin.kiosk.consent.empty.title")}
            hint={t("admin.kiosk.consent.empty.hint")}
            action={
              withTemplates ? (
                <Button variant="outline" asChild>
                  <Link to="/admin/kiosk/enrolment">{t("admin.kiosk.enrolment.title")}</Link>
                </Button>
              ) : (
                <Button onClick={() => setWithTemplates(true)}>
                  {t("admin.kiosk.consent.load")}
                </Button>
              )
            }
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label={t("admin.kiosk.consent.kpi.granted")}
            value={formatNumber(granted)}
            tone={granted > 0 ? "success" : "neutral"}
          />
          <KpiTile
            label={t("admin.kiosk.consent.kpi.withdrawn")}
            value={formatNumber(withdrawn)}
            tone="neutral"
          />
          <KpiTile
            label={t("admin.kiosk.consent.kpi.missing")}
            value={formatNumber(missing)}
            tone={missing > 0 ? "warn" : "success"}
          />
        </section>

        <DataGrid
          columns={columns}
          rows={visible}
          rowKey={(row) => row.employeeId}
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
              icon={ShieldCheck}
              title={t("admin.kiosk.consent.empty.title")}
              hint={t("admin.kiosk.consent.empty.hint")}
              action={
                <Button variant="outline" onClick={() => setFilter("all")}>
                  {t("admin.kiosk.consent.filter.all")}
                </Button>
              }
            />
          }
        />
      </StateBoundary>
    </div>
  );
}
