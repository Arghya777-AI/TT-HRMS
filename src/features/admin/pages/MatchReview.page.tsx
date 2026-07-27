/**
 * A-KIOSK-05 · /admin/kiosk/match-review — ambiguous, low-confidence and failed
 * identification attempts (spec-admin §5.9, view §3.4).
 *
 * `v_face_match_audit` is the whole screen. It is owner-executed behind
 * `app.is_admin()` over `secure.face_match_log`, and it deliberately OMITS
 * `candidate_scores`: the top-5 list is super-admin-only through
 * `reveal_face_match_candidates(id, reason)`, which writes its own
 * `data_access` reveal row. So the grid shows the decision, and the evidence
 * behind the decision needs a name and a sentence.
 *
 * Two things this screen must not do:
 *   * It must not re-derive an outcome. `outcome` is the engine's verdict, pinned
 *     with the `threshold_used` in force at that moment; comparing today's
 *     threshold against yesterday's confidence would rewrite history.
 *   * It must not show a face. `capture_photo_path` is not even in the
 *     projection — a signed URL for a punch frame is a 60-second audited reveal
 *     and does not belong in a list.
 *
 * @route /admin/kiosk/match-review
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ScanFace, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  fmtDateTime,
  fmtMonthLong,
  isIstMonthKey,
  istMonthRange,
  nowIstMonth,
} from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { asArray } from "@/lib/asArray";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { fetchEmployeeOptions, type DirectoryRow } from "../api/employees.api";
import { REVIEW_OUTCOMES, type CandidateReveal, type FaceMatchAudit } from "../api/kiosk.api";
import {
  useCandidateRevealMutation,
  useFaceMatchAudit,
  useKioskDevices,
} from "../hooks/useKioskConsole";
import { matchOutcomeChip } from "../kiosk-display";
import { MonthStepper } from "../components/MonthStepper";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { KioskSectionNav } from "../components/KioskSectionNav";

export default function MatchReviewPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const requested = params.get("m");
  const month = requested !== null && isIstMonthKey(requested) ? requested : nowIstMonth();
  const range = useMemo(() => istMonthRange(month), [month]);
  const [onlyReview, setOnlyReview] = useState(true);

  const attempts = useFaceMatchAudit(
    onlyReview
      ? { from: range.from, to: range.to, outcomes: REVIEW_OUTCOMES }
      : { from: range.from, to: range.to },
  );
  const devices = useKioskDevices();
  const reveal = useCandidateRevealMutation();
  const [revealed, setRevealed] = useState<ReadonlyMap<string, CandidateReveal>>(new Map());

  const employees = useQuery({
    queryKey: qk.admin.employees({ scope: "match-review" }),
    queryFn: ({ signal }) => fetchEmployeeOptions({}, 300, signal),
    retry: shouldRetryQuery,
  });

  const employeeById = useMemo(() => {
    const map = new Map<string, DirectoryRow>();
    for (const row of employees.data ?? []) map.set(row.id, row);
    return map;
  }, [employees.data]);

  const deviceById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of asArray(devices.data)) map.set(d.id, d.device_code);
    return map;
  }, [devices.data]);

  const rows = attempts.data ?? [];
  const reviewOutcomes: readonly string[] = REVIEW_OUTCOMES;
  const reviewable = rows.filter((r) => reviewOutcomes.includes(r.outcome)).length;

  function setMonth(next: string): void {
    const nextParams = new URLSearchParams(params);
    nextParams.set("m", next);
    setParams(nextParams, { replace: false });
  }

  const columns: DataGridColumn<FaceMatchAudit>[] = [
    {
      key: "attempted_at",
      header: t("admin.kiosk.match.col.when"),
      width: "13rem",
      sortable: true,
      render: (row) => <span className="num text-sm">{fmtDateTime(row.attempted_at)}</span>,
    },
    {
      key: "device",
      header: t("admin.kiosk.match.col.device"),
      width: "8rem",
      hideBelow: "md",
      render: (row) =>
        row.kiosk_device_id === null ? (
          dash(null)
        ) : (
          <span className="font-mono text-xs">{deviceById.get(row.kiosk_device_id) ?? dash(null)}</span>
        ),
    },
    {
      key: "outcome",
      header: t("admin.kiosk.match.col.outcome"),
      width: "12rem",
      render: (row) => <StatusChip status={row.outcome} map={matchOutcomeChip(row.outcome)} />,
    },
    {
      key: "employee",
      header: t("admin.kiosk.match.col.employee"),
      render: (row) => {
        if (row.matched_employee_id === null) return dash(null);
        const employee = employeeById.get(row.matched_employee_id);
        if (employee === undefined) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{employee.display_name}</span>
            <span className="font-mono text-xs text-muted-foreground">{employee.employee_code}</span>
          </span>
        );
      },
    },
    {
      key: "best_confidence",
      header: t("admin.kiosk.match.col.confidence"),
      align: "right",
      width: "8rem",
      hideBelow: "md",
      render: (row) => dash(row.best_confidence, (v) => v.toFixed(3)),
    },
    {
      key: "margin",
      header: t("admin.kiosk.match.col.margin"),
      align: "right",
      width: "9rem",
      hideBelow: "lg",
      render: (row) => dash(row.margin, (v) => v.toFixed(3)),
    },
    {
      key: "threshold_used",
      header: t("admin.kiosk.match.col.threshold"),
      align: "right",
      width: "8rem",
      hideBelow: "lg",
      render: (row) => dash(row.threshold_used, (v) => v.toFixed(2)),
    },
    {
      key: "liveness_score",
      header: t("admin.kiosk.match.col.liveness"),
      align: "right",
      hideBelow: "lg",
      render: (row) => dash(row.liveness_score, (v) => v.toFixed(2)),
    },
    {
      key: "candidate_set_size",
      header: t("admin.kiosk.match.col.compared"),
      align: "right",
      hideBelow: "lg",
      render: (row) => (
        <span className="num">
          {t("admin.kiosk.match.compared", { count: formatNumber(row.candidate_set_size) })}
        </span>
      ),
    },
    {
      key: "latency_ms",
      header: t("admin.kiosk.match.col.latency"),
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.latency_ms === null
          ? dash(null)
          : t("admin.settings.health.jobs.ms", { ms: formatNumber(row.latency_ms) }),
    },
    {
      key: "punch",
      header: t("admin.kiosk.match.col.punch"),
      width: "8rem",
      render: (row) =>
        row.produced_punch_id === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.kiosk.match.noPunch")}</span>
        ) : (
          <Badge variant="success">{t("admin.kiosk.match.punchCreated")}</Badge>
        ),
    },
    {
      key: "reveal",
      header: t("admin.kiosk.match.reveal"),
      align: "right",
      width: "13rem",
      render: (row) => {
        if (!isSuper) {
          return (
            <span className="text-xs text-muted-foreground">
              {t("admin.kiosk.match.reveal.superOnly")}
            </span>
          );
        }
        const shown = revealed.get(row.id);
        if (shown !== undefined) {
          return (
            <span className="flex flex-col items-end gap-1">
              <span className="text-xs font-medium">
                {t("admin.kiosk.match.reveal.heading", { when: fmtDateTime(row.attempted_at) })}
              </span>
              <pre className="max-w-[16rem] overflow-x-auto rounded border bg-muted/40 p-2 text-left font-mono text-[0.65rem] leading-tight">
                {JSON.stringify(shown.candidate_scores, null, 1)}
              </pre>
            </span>
          );
        }
        return (
          <ReasonActionButton
            label={t("admin.kiosk.match.reveal")}
            variant="ghost"
            minLength={reveal.minReasonLength}
            title={t("admin.kiosk.match.reveal.title")}
            description={t("admin.kiosk.match.reveal.description")}
            onConfirm={async (reason) => {
              const result = await reveal.saveAsync(row.id, reason);
              if (result !== null) {
                setRevealed((prev) => new Map(prev).set(row.id, result));
              }
            }}
          />
        );
      },
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScanFace}
        title={t("admin.kiosk.match.title")}
        subtitle={t("admin.kiosk.match.subtitle")}
        actions={<MonthStepper month={month} onChange={setMonth} />}
      />

      <KioskSectionNav />

      <p className="mb-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("admin.kiosk.match.thresholdNote")}
      </p>

      <StateBoundary
        loading={attempts.isLoading}
        error={attempts.error ?? undefined}
        onRetry={() => void attempts.refetch()}
        partialError={employees.error ?? devices.error ?? undefined}
        partialLabel={t("admin.kiosk.match.col.employee")}
        skeletonRows={6}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiTile
            label={t("admin.kiosk.match.kpi.review")}
            value={formatNumber(reviewable)}
            tone={reviewable > 0 ? "warn" : "success"}
            hint={t("admin.kiosk.match.kpi.reviewHint", { month: fmtMonthLong(month) })}
          />
          <KpiTile
            label={t("admin.kiosk.match.kpi.total")}
            value={formatNumber(rows.length)}
            hint={t("admin.kiosk.match.kpi.totalHint", { month: fmtMonthLong(month) })}
          />
        </section>

        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="flex flex-wrap gap-1" role="group">
              <Button
                size="sm"
                variant={onlyReview ? "default" : "outline"}
                aria-pressed={onlyReview}
                onClick={() => setOnlyReview(true)}
              >
                {t("admin.kiosk.match.filter.review")}
              </Button>
              <Button
                size="sm"
                variant={onlyReview ? "outline" : "default"}
                aria-pressed={!onlyReview}
                onClick={() => setOnlyReview(false)}
              >
                {t("admin.kiosk.match.filter.all")}
              </Button>
            </div>
          }
          emptyState={
            onlyReview ? (
              <EmptyState
                icon={ScanFace}
                title={t("admin.kiosk.match.emptyFiltered.title", { month: fmtMonthLong(month) })}
                hint={t("admin.kiosk.match.emptyFiltered.hint")}
                action={
                  <Button variant="outline" onClick={() => setOnlyReview(false)}>
                    {t("admin.kiosk.match.filter.all")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ScanFace}
                title={t("admin.kiosk.match.empty.title", { month: fmtMonthLong(month) })}
                hint={t("admin.kiosk.match.empty.hint")}
              />
            )
          }
        />
      </StateBoundary>
    </div>
  );
}
