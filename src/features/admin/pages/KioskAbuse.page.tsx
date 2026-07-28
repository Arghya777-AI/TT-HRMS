/**
 * A-KIOSK-07 · /admin/kiosk/abuse — the anti-abuse review queue (spec-admin
 * §5.9, void vocabulary from the deployed `void-punch` function).
 *
 * The one thing this screen exists to do that no other screen can: SHOW THE
 * VOIDS. `/admin/attendance/punches` reads `v_attendance_punch_detail`, whose
 * `ordered` CTE filters `WHERE NOT p.is_voided` — its own COMMENT says voided
 * punches are excluded from the view. So the Punch Log physically cannot display
 * a scan the gate threw away, and a spoof rejection is invisible there. This
 * queue reads `public.attendance_punches` itself, which migration 016 grants
 * SELECT to `authenticated` behind `attendance_punches__admin_read`.
 *
 * Three rules it keeps:
 *   * IT DOES NOT DECIDE WHAT WAS ABUSE. Every bucket is one server-side
 *     predicate over flags the gate already set — `needs_review`, the
 *     `"<code>: "` prefix `void-punch` writes into `void_reason`, or
 *     `source = 'kiosk_manual'`. Nothing is re-classified in the browser.
 *   * THE TAB COUNTS ARE POSTGRES'S. `useAbuseSignalCounts` runs `count=exact`
 *     over the SAME predicate builder the rows use, so a tab cannot promise four
 *     and list three (DR-29).
 *   * REFUSED AT THE GATE IS NOT THE SAME AS VOIDED AFTER THE FACT. Liveness
 *     failures and suppressed duplicates never became punches at all; they are
 *     counted separately, from `v_kiosk_health`, and labelled as such.
 *
 * A void is a correction, never a deletion: `void-punch` sets four columns on a
 * row that stays exactly where it was, and there is no un-void. The remedy for a
 * wrongly voided scan is a manual punch, not an edit.
 *
 * @route /admin/kiosk/abuse
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { PunchLocation } from "@/shared/ui/PunchLocation";
import {
  fmtDateTime,
  fmtMonthLong,
  isIstMonthKey,
  istMonthRange,
  nowIstMonth,
} from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  abuseBuckets,
  punchSignals,
  splitVoidReason,
  type AbuseBucket,
  type AbusePunch,
  type AbuseSignal,
} from "../api/kiosk-governance.api";
import type { VoidReasonCode } from "../api/attendance.api";
import { useAbusePunches, useAbuseSignalCounts } from "../hooks/useKioskGovernance";
import { useKioskDevices, useKioskHealth, useKioskOperators } from "../hooks/useKioskConsole";
import {
  newVoidIdempotencyKey,
  useVoidPunch,
  useVoidReasonCodeOptions,
  voidReasonCodeLabel,
  type VoidPunchInput,
} from "../hooks/usePunchConsole";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import { MonthStepper } from "../components/MonthStepper";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { KioskSectionNav } from "../components/KioskSectionNav";

/** The queue's default filing code: this screen is where a spoof gets recorded. */
const DEFAULT_VOID_CODE: VoidReasonCode = "spoof_rejected";

const BUCKET_LABEL: Readonly<Record<AbuseBucket, MessageKey>> = {
  flagged: "admin.kiosk.abuse.tab.flagged",
  spoof: "admin.kiosk.abuse.tab.spoof",
  duplicate: "admin.kiosk.abuse.tab.duplicate",
  day_limit: "admin.kiosk.abuse.tab.dayLimit",
  guard_assisted: "admin.kiosk.abuse.tab.guard",
};

const BUCKET_EMPTY_HINT: Readonly<Record<AbuseBucket, MessageKey>> = {
  flagged: "admin.kiosk.abuse.empty.hint.flagged",
  spoof: "admin.kiosk.abuse.empty.hint.spoof",
  duplicate: "admin.kiosk.abuse.empty.hint.duplicate",
  day_limit: "admin.kiosk.abuse.empty.hint.dayLimit",
  guard_assisted: "admin.kiosk.abuse.empty.hint.guard",
};

/**
 * The gate's own flags, as chips. `danger` is reserved for the two that mean a
 * person may not be who the camera decided they were; a replayed offline scan and
 * a drifting clock are provenance problems, not identity ones.
 */
const SIGNAL_CHIP: Readonly<Record<AbuseSignal, StatusChipEntry>> = {
  needs_review: { label: t("admin.kiosk.abuse.signal.needsReview"), tone: "warn" },
  duplicate_link: { label: t("admin.kiosk.abuse.signal.duplicate"), tone: "danger" },
  guard_assisted: { label: t("admin.kiosk.abuse.signal.guardAssisted"), tone: "danger" },
  offline_replay: { label: t("admin.kiosk.abuse.signal.offlineReplay"), tone: "info" },
  clock_skew: { label: t("admin.kiosk.abuse.signal.clockSkew"), tone: "warn" },
};

/**
 * The six codes `void-punch` accepts, toned by what they MEAN rather than by how
 * they were produced: `spoof_rejected` is an attack, `debounce` is the machine
 * being tidy.
 */
const VOID_CODE_TONE: Readonly<Record<VoidReasonCode, StatusChipEntry["tone"]>> = {
  spoof_rejected: "danger",
  rate_limit_day: "warn",
  admin_void: "info",
  reassigned: "info",
  debounce: "neutral",
  import_correction: "neutral",
};

function voidCodeChip(code: VoidReasonCode): Record<string, StatusChipEntry> {
  return { [code]: { label: voidReasonCodeLabel(code), tone: VOID_CODE_TONE[code] } };
}

function isAbuseBucket(value: string): value is AbuseBucket {
  return (abuseBuckets as readonly string[]).includes(value);
}

/** What the void dialog is asking about, plus the key that makes a retry safe. */
interface VoidTarget extends VoidPunchInput {
  readonly personLabel: string;
  readonly punchedAtLabel: string;
}

export default function KioskAbusePage() {
  const [params, setParams] = useSearchParams();
  const { employee } = useAuth();

  const requestedMonth = params.get("m");
  const month =
    requestedMonth !== null && isIstMonthKey(requestedMonth) ? requestedMonth : nowIstMonth();
  const range = useMemo(() => istMonthRange(month), [month]);

  const requestedBucket = params.get("q") ?? "";
  const bucket: AbuseBucket = isAbuseBucket(requestedBucket) ? requestedBucket : "flagged";

  const counts = useAbuseSignalCounts(range);
  const rows = useAbusePunches(bucket, range);
  const health = useKioskHealth(range.from, range.to);
  const labels = useEmployeeLabels();
  const devices = useKioskDevices();
  const operators = useKioskOperators();

  const [voidCode, setVoidCode] = useState<VoidReasonCode>(DEFAULT_VOID_CODE);
  const voidCodeChoices = useVoidReasonCodeOptions();

  const prompt = useReasonPrompt<VoidTarget>();
  const { target, isOpen, ask, close } = prompt;
  const [receipt, setReceipt] = useState<string | null>(null);

  const doVoid = useVoidPunch((input) => {
    close();
    setReceipt(
      t("admin.kiosk.abuse.done.voided", { code: voidReasonCodeLabel(input.voidReasonCode) }),
    );
  });

  const deviceById = useMemo(() => {
    const map = new Map<string, string>();
    for (const device of devices.data ?? []) map.set(device.id, device.device_code);
    return map;
  }, [devices.data]);

  /** operator row → the guard's employee id, so the label map can name them. */
  const operatorEmployeeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const operator of operators.data ?? []) {
      if (operator.employee_id !== null) map.set(operator.id, operator.employee_id);
    }
    return map;
  }, [operators.data]);

  // Sums over the exact `v_kiosk_health` rows the month covers — device × day,
  // one addition per tile, and the explainer names the row count so the reader
  // can check it. No rate is asserted (DR-28).
  const healthRows = health.data ?? [];
  const livenessRefused = healthRows.reduce((sum, row) => sum + row.liveness_failures, 0);
  const duplicatesSuppressed = healthRows.reduce((sum, row) => sum + row.duplicates_suppressed, 0);

  function setSearchParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    next.set(name, value);
    setParams(next, { replace: false });
  }

  function personOf(employeeId: string): { name: string | null; code: string | null } {
    const label = labels.data?.get(employeeId);
    return { name: label?.name ?? null, code: label?.code ?? null };
  }

  const columns: DataGridColumn<AbusePunch>[] = [
    {
      key: "punched_at",
      header: t("admin.kiosk.abuse.col.when"),
      width: "13rem",
      sortable: true,
      sortValue: (row) => row.punched_at,
      render: (row) => (
        <span className={cn("num text-sm", row.is_voided && "line-through opacity-60")}>
          {fmtDateTime(row.punched_at)}
        </span>
      ),
    },
    {
      key: "employee",
      header: t("admin.kiosk.abuse.col.employee"),
      sortable: true,
      sortValue: (row) => personOf(row.employee_id).code ?? "",
      render: (row) => {
        const person = personOf(row.employee_id);
        return (
          <span className={cn(row.is_voided && "opacity-60")}>
            <PersonCell name={person.name} code={person.code} />
          </span>
        );
      },
    },
    {
      key: "signals",
      header: t("admin.kiosk.abuse.col.signals"),
      width: "16rem",
      render: (row) => {
        const signals = punchSignals(row);
        if (signals.length === 0) {
          return <span className="text-xs text-muted-foreground">{t("admin.kiosk.abuse.signal.none")}</span>;
        }
        return (
          <span className="flex flex-wrap gap-1">
            {signals.map((signal) => (
              <StatusChip key={signal} status={signal} map={{ [signal]: SIGNAL_CHIP[signal] }} />
            ))}
          </span>
        );
      },
    },
    {
      key: "device",
      header: t("admin.kiosk.abuse.col.device"),
      width: "8rem",
      hideBelow: "md",
      render: (row) =>
        row.kiosk_device_id === null ? (
          dash(null)
        ) : (
          <span className="font-mono text-xs">
            {deviceById.get(row.kiosk_device_id) ?? dash(null)}
          </span>
        ),
    },
    {
      key: "operator",
      header: t("admin.kiosk.abuse.col.operator"),
      hideBelow: "lg",
      render: (row) => {
        if (row.operator_id === null) return dash(null);
        const employeeId = operatorEmployeeById.get(row.operator_id);
        if (employeeId === undefined) return dash(null);
        const person = personOf(employeeId);
        return <PersonCell name={person.name} code={person.code} />;
      },
    },
    {
      /*
        WHERE. On a queue whose whole purpose is deciding whether a scan was
        legitimate, the place is frequently the deciding fact — an offline replay
        recorded at the gate is a clock problem; the same replay recorded two
        kilometres away is something else entirely.

        `showWhenAbsent` is left on: for THIS queue a missing fix is itself a
        signal worth seeing, unlike an employee's own timeline where it would read
        as an accusation.
      */
      key: "lat",
      header: t("punch.place.column"),
      width: "20rem",
      hideBelow: "lg",
      render: (row) => <PunchLocation row={row} variant="inline" />,
    },
    {
      key: "match_confidence",
      header: t("admin.kiosk.abuse.col.confidence"),
      align: "right",
      width: "8rem",
      hideBelow: "lg",
      render: (row) => dash(row.match_confidence, (v) => v.toFixed(3)),
    },
    {
      key: "state",
      header: t("admin.kiosk.abuse.col.state"),
      width: "18rem",
      render: (row) => {
        if (!row.is_voided) {
          return (
            <StatusChip
              status="live"
              map={{ live: { label: t("admin.kiosk.abuse.state.live"), tone: "success" } }}
            />
          );
        }
        const split = splitVoidReason(row.void_reason);
        return (
          <span className="flex flex-col gap-1 leading-tight">
            {split.code === null ? (
              <StatusChip
                status="voided"
                map={{ voided: { label: t("admin.kiosk.abuse.state.voided"), tone: "danger" } }}
              />
            ) : (
              <StatusChip status={split.code} map={voidCodeChip(split.code)} />
            )}
            <span className="text-xs text-muted-foreground">
              {row.voided_at === null
                ? t("admin.kiosk.abuse.state.voidedNoTime")
                : t("admin.kiosk.abuse.state.voidedAt", { at: fmtDateTime(row.voided_at) })}
            </span>
            {split.text !== null ? (
              <span className="break-words text-xs text-muted-foreground">{split.text}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: t("admin.kiosk.abuse.col.actions"),
      width: "9rem",
      align: "right",
      render: (row) => {
        if (row.is_voided) {
          return (
            <span className="text-xs text-muted-foreground">
              {t("admin.kiosk.abuse.alreadyVoided")}
            </span>
          );
        }
        const person = personOf(row.employee_id);
        return (
          <Button
            size="sm"
            variant="outline"
            disabled={doVoid.isPending}
            onClick={() =>
              ask({
                punchId: row.id,
                punchedAt: row.punched_at,
                voidReasonCode: voidCode,
                idempotencyKey: newVoidIdempotencyKey(),
                personLabel: person.name ?? person.code ?? t("admin.common.unknownPerson"),
                punchedAtLabel: fmtDateTime(row.punched_at),
              })
            }
          >
            {t("admin.kiosk.abuse.action.void")}
          </Button>
        );
      },
    },
  ];

  const bucketCount = counts.data?.[bucket] ?? null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.kiosk.abuse.title")}
        subtitle={t("admin.kiosk.abuse.subtitle")}
        actions={<MonthStepper month={month} onChange={(next) => setSearchParam("m", next)} />}
      />

      <KioskSectionNav />

      <Notice tone="info">{t("admin.kiosk.abuse.evidenceNotice")}</Notice>

      <section className="mb-6 mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiTile
          label={t("admin.kiosk.abuse.kpi.flagged")}
          value={dash(counts.data?.flagged, formatNumber)}
          tone={(counts.data?.flagged ?? 0) > 0 ? "warn" : "success"}
          hint={t("admin.kiosk.abuse.kpi.flaggedHint")}
        />
        <KpiTile
          label={t("admin.kiosk.abuse.kpi.spoof")}
          value={dash(counts.data?.spoof, formatNumber)}
          tone={(counts.data?.spoof ?? 0) > 0 ? "danger" : "success"}
          hint={t("admin.kiosk.abuse.kpi.spoofHint")}
        />
        <KpiTile
          label={t("admin.kiosk.abuse.kpi.duplicate")}
          value={dash(counts.data?.duplicate, formatNumber)}
          hint={t("admin.kiosk.abuse.kpi.duplicateHint")}
        />
        <KpiTile
          label={t("admin.kiosk.abuse.kpi.dayLimit")}
          value={dash(counts.data?.day_limit, formatNumber)}
          tone={(counts.data?.day_limit ?? 0) > 0 ? "warn" : "neutral"}
          hint={t("admin.kiosk.abuse.kpi.dayLimitHint")}
        />
        <KpiTile
          label={t("admin.kiosk.abuse.kpi.guard")}
          value={dash(counts.data?.guard_assisted, formatNumber)}
          tone={(counts.data?.guard_assisted ?? 0) > 0 ? "warn" : "neutral"}
          hint={t("admin.kiosk.abuse.kpi.guardHint")}
        />
      </section>

      <h2 className="mb-2 font-display text-lg font-semibold">
        {t("admin.kiosk.abuse.gate.title")}
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">{t("admin.kiosk.abuse.gate.hint")}</p>

      <StateBoundary
        loading={health.isLoading}
        error={health.error ?? undefined}
        onRetry={() => void health.refetch()}
        skeletonRows={1}
      >
        <section className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiTile
            label={t("admin.kiosk.abuse.kpi.liveness")}
            value={formatNumber(livenessRefused)}
            tone={livenessRefused > 0 ? "warn" : "success"}
            explainer={{
              formula: t("admin.kiosk.abuse.kpi.livenessFormula"),
              numbers: t("admin.kiosk.abuse.kpi.gateNumbers", {
                value: formatNumber(livenessRefused),
                rows: formatNumber(healthRows.length),
                month: fmtMonthLong(month),
              }),
            }}
          />
          <KpiTile
            label={t("admin.kiosk.abuse.kpi.suppressed")}
            value={formatNumber(duplicatesSuppressed)}
            explainer={{
              formula: t("admin.kiosk.abuse.kpi.suppressedFormula"),
              numbers: t("admin.kiosk.abuse.kpi.gateNumbers", {
                value: formatNumber(duplicatesSuppressed),
                rows: formatNumber(healthRows.length),
                month: fmtMonthLong(month),
              }),
            }}
          />
        </section>
      </StateBoundary>

      {bucket === "flagged" ? (
        <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
          <SelectField
            label={t("admin.kiosk.abuse.voidCode.label")}
            value={voidCode}
            options={voidCodeChoices}
            onChange={(value) => setVoidCode(value as VoidReasonCode)}
            hint={t("admin.kiosk.abuse.voidCode.hint")}
          />
        </div>
      ) : null}

      {receipt !== null ? (
        <Notice
          tone="success"
          className="mb-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setReceipt(null)}>
              {t("admin.common.dismiss")}
            </Button>
          }
        >
          {receipt}
        </Notice>
      ) : null}

      <StateBoundary
        loading={rows.isLoading}
        error={rows.error ?? undefined}
        onRetry={() => void rows.refetch()}
        partialError={counts.error ?? labels.error ?? devices.error ?? operators.error ?? undefined}
        partialLabel={t("admin.kiosk.abuse.partial")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows.data ?? []}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="flex w-full flex-col gap-2">
              <div className="flex flex-wrap gap-1" role="group" aria-label={t("admin.kiosk.abuse.tabs")}>
                {abuseBuckets.map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={bucket === key ? "default" : "outline"}
                    aria-pressed={bucket === key}
                    onClick={() => setSearchParam("q", key)}
                  >
                    {t("admin.kiosk.abuse.tab.withCount", {
                      label: t(BUCKET_LABEL[key]),
                      count: dash(counts.data?.[key], formatNumber),
                    })}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {bucketCount === null
                  ? t("admin.kiosk.abuse.showing.unknown", { month: fmtMonthLong(month) })
                  : t("admin.kiosk.abuse.showing", {
                      shown: formatNumber((rows.data ?? []).length),
                      total: formatNumber(bucketCount),
                      month: fmtMonthLong(month),
                    })}
              </p>
            </div>
          }
          emptyState={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.kiosk.abuse.empty.title", {
                label: t(BUCKET_LABEL[bucket]),
                month: fmtMonthLong(month),
              })}
              hint={t(BUCKET_EMPTY_HINT[bucket])}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/kiosk/match-review">{t("admin.kiosk.match.title")}</Link>
                </Button>
              }
            />
          }
        />
      </StateBoundary>

      <p className="mt-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-medium text-foreground">
            {t("admin.kiosk.abuse.footnote.title")}
          </strong>{" "}
          {t("admin.kiosk.abuse.footnote.hint")}
        </span>
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="ghost" asChild>
          <Link to="/admin/attendance/punches">{t("admin.punch.title")}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/admin/kiosk/policy">{t("admin.kiosk.policy.title")}</Link>
        </Button>
      </div>

      <ReasonDialog
        open={isOpen}
        title={t("admin.kiosk.abuse.dialog.title", {
          name: target?.personLabel ?? "",
          at: target?.punchedAtLabel ?? "",
        })}
        description={t("admin.kiosk.abuse.dialog.description", {
          code: target === null ? "" : voidReasonCodeLabel(target.voidReasonCode),
        })}
        actorName={employee?.displayName ?? null}
        minLength={doVoid.minReasonLength}
        confirmLabel={t("admin.kiosk.abuse.dialog.confirm")}
        pending={doVoid.isPending}
        errorMessage={doVoid.userMessage}
        onConfirm={(reason) => {
          if (target === null) return;
          doVoid.save(
            {
              punchId: target.punchId,
              punchedAt: target.punchedAt,
              voidReasonCode: target.voidReasonCode,
              idempotencyKey: target.idempotencyKey,
            },
            reason,
          );
        }}
        onCancel={() => {
          if (doVoid.isPending) return;
          close();
        }}
      />

      <p className="sr-only" aria-live="polite">
        {rows.isFetching ? t("app.loading") : ""}
      </p>
    </div>
  );
}
