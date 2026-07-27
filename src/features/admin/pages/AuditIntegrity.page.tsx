/**
 * A-13.6 · /admin/audit/integrity — Integrity & Tamper Evidence.
 *
 * WHAT THIS SCREEN CAN AND CANNOT DO — stated up front, because the honest
 * version is less than §13.6 describes and pretending otherwise would be the
 * worst possible defect on a tamper-evidence page:
 *
 *  * `audit.verify_chain(from, to)` lives in the `audit` SCHEMA. PostgREST
 *    exposes `public` only, so the browser cannot call it. There is no
 *    `public.*` wrapper in the migrations.
 *  * `cron-integrity`, the edge function that does call it, is auth model C:
 *    a cron secret or a service-role bearer. An admin's JWT is refused.
 *  * Therefore there is NO on-demand "Verify now" button. Offering one that
 *    silently did nothing, or that only re-read a cached verdict, would be worse
 *    than not offering it.
 *
 * So the screen reports the SERVER's verdict and is precise about its age:
 *  - `audit_seals` — one row per IST day, written at 02:15 IST by the nightly
 *    job: the day's `first_seq`..`last_seq`, `row_count`, the `terminal_hash`
 *    (the `row_hash` of the day's last row), and `verification_result` +
 *    `verified_at` from the `verify_chain` walk that ran alongside it.
 *  - `system_health` where `component LIKE 'integrity.%'` — the verifier's own
 *    findings, including `integrity.audit_chain` / `chain_breaks`, which is the
 *    row that turns Critical when the chain does not reproduce.
 *
 * `audit_seals` has UPDATE and DELETE revoked from every client role and a
 * BEFORE trigger that raises 0A000, so a seal is written once and never touched
 * again. That is why a seal row is evidence: it cannot have been edited after the
 * fact by anything this application can reach.
 *
 * @route /admin/audit/integrity
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, FileWarning, Fingerprint, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { addIstDays, civilDayOffset, fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AuditSealRow, IntegrityHealthRow } from "../api/audit-registers.api";
import { groupHash, humanise, verificationChip } from "../audit/display";
import { useAuditSeals, useIntegrityHealth, useOpenIntegrityFindings } from "../audit/hooks";
import { RangeFilter } from "../audit/components/AuditFilterBar";
import { useAuditUrlFilters } from "../audit/url-state";

/** How many IST days back the seal ladder is inspected by default. */
const DEFAULT_SEAL_WINDOW_DAYS = 90;

export default function AuditIntegrityPage() {
  const { params, preset, window, patch } = useAuditUrlFilters("d90");

  // A diff row deep-links here with `?seal=<ist_date>` so an auditor can tie one
  // event's row_hash to the day that sealed it.
  const highlightSeal = params.get("seal");

  const seals = useAuditSeals(window.from, window.to);
  const health = useIntegrityHealth();
  const openFindings = useOpenIntegrityFindings();

  // Memoised: `seals.data ?? []` is a fresh array on every render, which would
  // make every derived figure below recompute on every keystroke elsewhere.
  const sealRows = useMemo(() => seals.data ?? [], [seals.data]);

  // Every figure below is over the EXACT series in the grid, and each explainer
  // says so. There is no server view that aggregates seals, and a total invented
  // here would be the "dashboard disagrees with its own detail" defect.
  const latest = sealRows[0];
  const broken = useMemo(
    () => sealRows.filter((s) => s.verification_result === "chain_broken"),
    [sealRows],
  );
  const unverified = useMemo(
    () => sealRows.filter((s) => s.verification_result !== "ok"),
    [sealRows],
  );
  const sealedRowTotal = useMemo(
    () => sealRows.reduce((sum, s) => sum + s.row_count, 0),
    [sealRows],
  );

  /**
   * Days inside the window that have NO seal row. A gap is not proof of tampering
   * — a day with zero audit rows is legitimately never sealed (`cron-integrity`
   * records "nothing to seal"), and today has not been sealed yet because the job
   * runs at 02:15 the following morning. Both are excluded, and the label says
   * which days are actually missing evidence.
   */
  const gaps = useMemo(() => {
    const sealed = new Set(sealRows.map((s) => s.seal_date));
    const today = nowIstDate();
    const out: string[] = [];
    const span = civilDayOffset(window.from, window.to);
    if (span < 0 || span > 400) return out;
    for (let i = 0; i <= span; i += 1) {
      const day = addIstDays(window.from, i);
      // Today and yesterday: the 02:15 job may not have run for them yet.
      if (civilDayOffset(day, today) <= 1) continue;
      if (!sealed.has(day)) out.push(day);
    }
    return out;
  }, [sealRows, window.from, window.to]);

  const chainVerdict = useMemo((): { tone: "success" | "danger" | "warn"; key: "ok" | "broken" | "stale" } => {
    if (broken.length > 0) return { tone: "danger", key: "broken" };
    if (latest === undefined) return { tone: "warn", key: "stale" };
    if (latest.verification_result === "ok") return { tone: "success", key: "ok" };
    return { tone: "warn", key: "stale" };
  }, [broken.length, latest]);

  const scopeNumbers = t("adminAudit.integrity.scopeNumbers", {
    n: formatNumber(sealRows.length),
    from: fmtCivilDate(window.from),
    to: fmtCivilDate(window.to),
  });

  const sealColumns: DataGridColumn<AuditSealRow>[] = useMemo(
    () => [
      {
        key: "seal_date",
        header: t("adminAudit.integrity.col.day"),
        width: "11rem",
        sortable: true,
        sortValue: (row) => row.seal_date,
        render: (row) => (
          <span
            className={
              row.seal_date === highlightSeal
                ? "num rounded bg-primary/10 px-1.5 py-0.5 font-medium"
                : "num"
            }
          >
            {fmtCivilDate(row.seal_date)}
          </span>
        ),
      },
      {
        key: "verification_result",
        header: t("adminAudit.integrity.col.verification"),
        width: "11rem",
        render: (row) => (
          <StatusChip
            status={row.verification_result ?? "not_verified"}
            map={verificationChip(row.verification_result)}
          />
        ),
      },
      {
        key: "row_count",
        header: t("adminAudit.integrity.col.rows"),
        width: "7rem",
        align: "right",
        render: (row) => formatNumber(row.row_count),
      },
      {
        key: "seq",
        header: t("adminAudit.integrity.col.seq"),
        width: "11rem",
        align: "right",
        hideBelow: "md",
        render: (row) => (
          <span className="num">
            {formatNumber(row.first_seq)}–{formatNumber(row.last_seq)}
          </span>
        ),
      },
      {
        key: "terminal_hash",
        header: t("adminAudit.integrity.col.terminalHash"),
        hideBelow: "md",
        render: (row) => (
          <span className="select-all break-all font-mono text-xs" title={row.terminal_hash}>
            {groupHash(row.terminal_hash)}
          </span>
        ),
      },
      {
        key: "verified_at",
        header: t("adminAudit.integrity.col.verifiedAt"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) =>
          row.verified_at === null ? (
            <span className="text-xs text-muted-foreground">
              {t("adminAudit.integrity.neverVerified")}
            </span>
          ) : (
            <span className="num whitespace-nowrap text-xs">{fmtDateTime(row.verified_at)}</span>
          ),
      },
      {
        key: "external_anchor",
        header: t("adminAudit.integrity.col.anchor"),
        width: "9rem",
        hideBelow: "lg",
        render: (row) =>
          row.external_anchor === null || row.external_anchor === "" ? (
            <span className="text-xs text-muted-foreground">
              {t("adminAudit.integrity.noAnchor")}
            </span>
          ) : (
            <span className="font-mono text-xs">{row.external_anchor}</span>
          ),
      },
      {
        key: "sealed_by",
        header: t("adminAudit.integrity.col.sealedBy"),
        width: "10rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="font-mono text-xs">{row.sealed_by}</span>
            <span className="num text-xs text-muted-foreground">{fmtDateTime(row.sealed_at)}</span>
          </span>
        ),
      },
    ],
    [highlightSeal],
  );

  const healthColumns: DataGridColumn<IntegrityHealthRow>[] = useMemo(
    () => [
      {
        key: "checked_at",
        header: t("adminAudit.col.when"),
        width: "12rem",
        render: (row) => (
          <span className="num whitespace-nowrap">{fmtDateTime(row.checked_at)}</span>
        ),
      },
      {
        key: "component",
        header: t("adminAudit.integrity.col.check"),
        width: "14rem",
        // `integrity.audit_chain` → "Audit chain": the component token is an
        // internal name and never goes on screen raw (D-10/11).
        render: (row) => humanise(row.component.replace(/^integrity\./, "")),
      },
      {
        key: "status",
        header: t("adminAudit.integrity.col.status"),
        width: "9rem",
        render: (row) => <StatusChip status={row.status} />,
      },
      {
        key: "message",
        header: t("adminAudit.integrity.col.finding"),
        render: (row) => <span className="text-sm">{dash(row.message)}</span>,
      },
      {
        key: "resolved_at",
        header: t("adminAudit.integrity.col.resolved"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) =>
          row.resolved_at === null ? (
            <span className="text-xs font-medium text-warning">
              {t("adminAudit.integrity.open")}
            </span>
          ) : (
            <span className="num text-xs">{fmtDateTime(row.resolved_at)}</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Fingerprint}
        title={t("adminAudit.integrity.title")}
        subtitle={t("adminAudit.integrity.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/audit">{t("adminAudit.diff.backToTimeline")}</Link>
          </Button>
        }
      />

      {/* The Critical banner. A broken chain means the audit log is DISPUTED, and
          the copy says exactly that rather than "an issue was detected". */}
      {broken.length > 0 || (openFindings.data ?? []).some((f) => f.status === "down") ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border-2 border-destructive bg-destructive/5 p-4"
          role="alert"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="font-display font-semibold text-destructive">
              {t("adminAudit.integrity.alert.title")}
            </p>
            <p className="mt-1 text-sm">{t("adminAudit.integrity.alert.body")}</p>
          </div>
        </div>
      ) : null}

      {/* How verification actually happens here. Not a disclaimer in small print:
          an auditor needs to know the verdict's provenance and its cadence. */}
      <section className="mb-4 rounded-lg border bg-card p-4">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t("adminAudit.integrity.how.title")}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("adminAudit.integrity.how.body")}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("adminAudit.integrity.how.noManual")}
        </p>
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RangeFilter preset={preset} window={window} patch={patch} />
        <span className="text-xs text-muted-foreground">
          {t("adminAudit.integrity.windowHint", { days: DEFAULT_SEAL_WINDOW_DAYS })}
        </span>
      </div>

      <StateBoundary
        loading={seals.isLoading}
        error={seals.error ?? undefined}
        onRetry={() => void seals.refetch()}
        partialError={health.error ?? openFindings.error ?? undefined}
        partialLabel={t("adminAudit.integrity.checksLabel")}
        skeletonRows={6}
      >
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label={t("adminAudit.integrity.kpi.chain")}
            value={t(
              chainVerdict.key === "ok"
                ? "adminAudit.integrity.kpi.chainOk"
                : chainVerdict.key === "broken"
                  ? "adminAudit.integrity.kpi.chainBroken"
                  : "adminAudit.integrity.kpi.chainStale",
            )}
            tone={chainVerdict.tone}
            explainer={{
              formula: t("adminAudit.integrity.kpi.chainFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("adminAudit.integrity.kpi.lastSealed")}
            value={latest === undefined ? t("common.empty") : fmtCivilDate(latest.seal_date)}
            {...(latest?.verified_at != null
              ? { hint: t("adminAudit.integrity.kpi.lastVerified", { when: fmtDateTime(latest.verified_at) }) }
              : {})}
            tone={latest === undefined ? "warn" : "neutral"}
            explainer={{
              formula: t("adminAudit.integrity.kpi.lastSealedFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("adminAudit.integrity.kpi.sealedRows")}
            value={sealRows.length === 0 ? t("common.empty") : formatNumber(sealedRowTotal)}
            explainer={{
              formula: t("adminAudit.integrity.kpi.sealedRowsFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("adminAudit.integrity.kpi.unsealedDays")}
            value={formatNumber(gaps.length)}
            tone={gaps.length > 0 ? "warn" : "success"}
            explainer={{
              formula: t("adminAudit.integrity.kpi.unsealedDaysFormula"),
              numbers: scopeNumbers,
            }}
          />
        </div>

        {gaps.length > 0 ? (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>
              {t("adminAudit.integrity.gaps", {
                n: gaps.length,
                days: gaps.slice(0, 8).map(fmtCivilDate).join(", "),
              })}
              {gaps.length > 8 ? t("adminAudit.integrity.gapsMore", { n: gaps.length - 8 }) : ""}
            </span>
          </div>
        ) : sealRows.length > 0 && unverified.length === 0 ? (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm">
            <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>{t("adminAudit.integrity.allVerified", { n: sealRows.length })}</span>
          </div>
        ) : null}

        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("adminAudit.integrity.seals.title")}
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          {t("adminAudit.integrity.seals.hint")}
        </p>
        <DataGrid
          columns={sealColumns}
          rows={sealRows}
          rowKey={(row) => row.id}
          pageSize={31}
          emptyState={
            <EmptyState
              icon={Fingerprint}
              title={t("adminAudit.integrity.seals.empty.title")}
              hint={t("adminAudit.integrity.seals.empty.hint")}
            />
          }
        />

        <h2 className="mb-2 mt-6 font-display text-lg font-semibold">
          {t("adminAudit.integrity.checks.title")}
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          {t("adminAudit.integrity.checks.hint")}
        </p>
        <StateBoundary
          loading={health.isLoading}
          error={health.error ?? undefined}
          onRetry={() => void health.refetch()}
          skeletonRows={3}
        >
          <DataGrid
            columns={healthColumns}
            rows={health.data ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            emptyState={
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.integrity.checks.empty.title")}
                hint={t("adminAudit.integrity.checks.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("adminAudit.integrity.footnote")}</p>
    </div>
  );
}
