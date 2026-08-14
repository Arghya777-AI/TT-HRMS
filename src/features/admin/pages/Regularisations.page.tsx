/**
 * §4 · /admin/attendance/regularisations — Regularisation Requests. Correction
 * requests awaiting a decision, and the history of those already decided.
 *
 * The design centre of this screen is the COMPARISON: for every pending request
 * it shows, side by side,
 *
 *     what the day looks like NOW   (v_attendance_day_enriched — the engine's
 *                                    columns, e.g. "09:12 → no out scan, half day")
 *     what the employee CLAIMS      (the requested times / status, plus their
 *                                    mandatory ≥15-char reason)
 *
 * so the decision is made on evidence, not memory. Nothing is derived here.
 *
 * Deciding goes through `public.decide_regularization` (migration 056), which
 * re-asserts authorisation server-side, and on approval creates the
 * `system_regularization` punches, stamps `created_punch_ids`, and recomputes
 * the day in the SAME transaction — the success banner shows the corrected day
 * returned by that one round trip. Rejection demands a comment because the
 * requester reads it on /me/regularizations.
 *
 * The quota chip prints `month_quota_counter` — stamped by the window-guard
 * trigger, never recomputed — so an admin can see "this is their 3rd of 3 this
 * month" while deciding.
 *
 * @route /admin/attendance/regularisations
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ClipboardList, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { fmtCivilDateWeekday, fmtDateTime, fmtDuration, fmtTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useDaysNow,
  useDecideRegularization,
  useRegularizationCount,
  useRegularizationQueue,
} from "../hooks/useRegularizationQueue";
import {
  regularizationKindSchema,
  type Regularization,
  type RegularizationKind,
  type RegularizationStatus,
} from "../api/regularizations-admin.api";

const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.regq.status.pending"), tone: "warn" },
  approved: { label: t("admin.regq.status.approved"), tone: "info" },
  applied: { label: t("admin.regq.status.applied"), tone: "success" },
  rejected: { label: t("admin.regq.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.regq.status.cancelled"), tone: "neutral" },
  draft: { label: t("admin.regq.status.draft"), tone: "neutral" },
};

function kindLabel(kind: RegularizationKind): string {
  switch (kind) {
    case "missed_in":
      return t("admin.regq.kind.missedIn");
    case "missed_out":
      return t("admin.regq.kind.missedOut");
    case "missed_both":
      return t("admin.regq.kind.missedBoth");
    case "wrong_time":
      return t("admin.regq.kind.wrongTime");
    case "marked_absent":
      return t("admin.regq.kind.markedAbsent");
    case "on_duty":
      return t("admin.regq.kind.onDuty");
    case "work_from_home":
      return t("admin.regq.kind.workFromHome");
    case "shift_mismatch":
      return t("admin.regq.kind.shiftMismatch");
    case "break_correction":
      return t("admin.regq.kind.breakCorrection");
  }
}

type ViewSlice = "pending" | "decided" | "all";

const VIEW_STATUSES: Record<ViewSlice, readonly RegularizationStatus[] | undefined> = {
  pending: ["pending"],
  decided: ["applied", "approved", "rejected"],
  all: undefined,
};

/** The claim, rendered from the request's own fields. */
function Claim({ row }: { row: Regularization }) {
  if (row.requested_status !== null) {
    return (
      <span className="text-sm">
        {row.requested_status === "on_duty"
          ? t("admin.regq.claim.onDuty")
          : t("admin.regq.claim.workFromHome")}
      </span>
    );
  }
  return (
    <span className="num text-sm">
      {row.requested_first_in_at !== null ? fmtTime(row.requested_first_in_at) : "—"}
      {" → "}
      {row.requested_last_out_at !== null ? fmtTime(row.requested_last_out_at) : "—"}
    </span>
  );
}

export default function RegularisationsPage() {
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const view: ViewSlice = rawView === "decided" || rawView === "all" ? rawView : "pending";
  const [kind, setKind] = useState<RegularizationKind | "">("");

  const filters = useMemo(
    () => ({
      ...(VIEW_STATUSES[view] !== undefined ? { statuses: VIEW_STATUSES[view] } : {}),
      ...(kind !== "" ? { kinds: [kind] as const } : {}),
    }),
    [view, kind],
  );

  const queue = useRegularizationQueue(filters);
  const rows = useMemo(() => queue.data ?? [], [queue.data]);
  const total = useRegularizationCount(filters);
  const pendingCount = useRegularizationCount({ statuses: ["pending"] });
  const labels = useEmployeeLabels();
  const { byPair } = useDaysNow(rows);
  const decide = useDecideRegularization();

  const [target, setTarget] = useState<{ row: Regularization; action: "approve" | "reject" } | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);

  const setView = (next: ViewSlice) => {
    const p = new URLSearchParams(params);
    if (next === "pending") p.delete("view");
    else p.set("view", next);
    setParams(p, { replace: true });
  };

  const personOf = (employeeId: string) => labels.data?.get(employeeId) ?? null;

  const confirm = (comment: string) => {
    if (target === null) return;
    const { row, action } = target;
    decide.save(
      { regularizationId: row.id, decision: action, comment },
      // The typed sentence serves as BOTH the audit reason and the comment the
      // requester reads — one honest sentence, two audiences.
      comment,
    );
    setTarget(null);
    setLastOutcome(null);
  };

  // Surface the corrected day from the decision's own return value.
  const result = decide.data;
  const outcomeLine =
    result === undefined
      ? null
      : result.decision === "rejected"
        ? t("admin.regq.outcome.rejected")
        : t("admin.regq.outcome.applied", {
            punches: formatNumber(result.punch_ids.length),
            status: dash(result.day_status_after ?? null),
            firstIn: result.first_in_after != null ? fmtTime(result.first_in_after) : "—",
            lastOut: result.last_out_after != null ? fmtTime(result.last_out_after) : "—",
            worked: fmtDuration(result.worked_minutes_after ?? null),
          });

  return (
    <div className="container py-6">
      <PageHeader
        icon={ClipboardList}
        title={t("admin.regq.title")}
        subtitle={
          pendingCount.isSuccess
            ? t("admin.regq.subtitle", { n: formatNumber(pendingCount.data) })
            : t("admin.regq.subtitlePlain")
        }
      />

      {/*
        HOW MUCH IS STILL WAITING. `pending` is a subset of the filtered total, so
        the remainder — everything already decided — is exact.

        A regularisation is somebody saying the clock got their day wrong. A large
        pending share is not a queue problem so much as a signal that the gate or
        the roster is producing bad days faster than anybody can correct them.
      */}
      {total.data !== undefined && pendingCount.data !== undefined && total.data > 0 ? (
        <div className="mt-4">
          <StatusMixCard
            title={t("admin.regq.mix.title")}
            hint={t("admin.regq.mix.hint")}
            format={(v) => formatNumber(v)}
            totalCaption={(n) => t("admin.regq.mix.total", { n: formatNumber(n) })}
            segments={[
              {
                key: "pending",
                label: t("admin.regq.mix.pending"),
                value: pendingCount.data,
                tone: "late",
              },
              {
                key: "decided",
                label: t("admin.regq.mix.decided"),
                value: Math.max(total.data - pendingCount.data, 0),
                tone: "present",
              },
            ]}
          />
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-4">
        <SelectField
          label={t("admin.regq.filter.view")}
          value={view}
          options={[
            { value: "pending", label: t("admin.regq.view.pending") },
            { value: "decided", label: t("admin.regq.view.decided") },
            { value: "all", label: t("admin.regq.view.all") },
          ]}
          onChange={(v) => setView(v as ViewSlice)}
        />
        <SelectField
          label={t("admin.regq.filter.kind")}
          value={kind}
          placeholder={t("admin.regq.filter.anyKind")}
          options={regularizationKindSchema.options.map((k) => ({
            value: k,
            label: kindLabel(k),
          }))}
          onChange={(v) => setKind(v as RegularizationKind | "")}
        />
        <div className="flex items-end">
          {kind !== "" ? (
            <Button variant="ghost" onClick={() => setKind("")}>
              {t("admin.regq.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {total.isSuccess
              ? t("admin.regq.matching", { n: formatNumber(total.data) })
              : t("admin.regq.matchingUnknown")}
          </p>
        </div>
      </div>

      {outcomeLine !== null && lastOutcome === null ? (
        <div className="mt-4">
          <Notice
            tone={result?.decision === "rejected" ? "info" : "success"}
            action={
              <Button variant="ghost" size="sm" onClick={() => setLastOutcome("dismissed")}>
                {t("admin.regq.dismiss")}
              </Button>
            }
          >
            {outcomeLine}
          </Notice>
        </div>
      ) : null}

      {decide.userMessage !== null && target === null ? (
        <div className="mt-4">
          <Notice tone="error">{decide.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={queue.isPending}
          error={queue.error}
          onRetry={() => void queue.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={
                view === "pending"
                  ? t("admin.regq.empty.pendingTitle")
                  : t("admin.regq.empty.title")
              }
              hint={
                view === "pending" ? t("admin.regq.empty.pendingHint") : t("admin.regq.empty.hint")
              }
            />
          }
        >
          <ul className="space-y-3">
            {rows.map((row) => {
              const who = personOf(row.employee_id);
              const now = byPair.get(`${row.employee_id}|${row.ist_date}`);
              const locked = now?.is_locked === true;
              return (
                <li key={row.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-4">
                      <PersonCell
                        name={who?.name ?? null}
                        code={who?.code ?? null}
                        secondary={fmtCivilDateWeekday(row.ist_date)}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{kindLabel(row.regularization_kind)}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("admin.regq.raised", { at: fmtDateTime(row.created_at) })}
                          {row.month_quota_counter !== null
                            ? " · " +
                              t("admin.regq.quota", { n: String(row.month_quota_counter) })
                            : null}
                        </p>
                      </div>
                    </div>
                    <StatusChip status={row.status} map={STATUS_CHIP} />
                  </div>

                  {/* The comparison: now vs claim. */}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">{t("admin.regq.now.title")}</p>
                      {now === undefined ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t("admin.regq.now.noRecord")}
                        </p>
                      ) : (
                        <p className="num mt-1 text-sm">
                          {dash(now.first_in_hm)} → {dash(now.last_out_hm)}
                          <span className="ml-2 text-muted-foreground">
                            {dash(now.worked_hm)} · {dash(now.status)}
                          </span>
                        </p>
                      )}
                      {locked ? (
                        <p className="mt-1 text-xs font-medium text-warning">
                          {t("admin.regq.now.locked")}
                        </p>
                      ) : null}
                    </div>
                    <div className={cn("rounded-md border p-3", row.status === "pending" && "border-primary/40")}>
                      <p className="text-xs text-muted-foreground">{t("admin.regq.claim.title")}</p>
                      <div className="mt-1">
                        <Claim row={row} />
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 text-sm">
                    <span className="text-muted-foreground">{t("admin.regq.theirReason")} </span>
                    {row.employee_reason}
                  </p>

                  {row.decision_comment !== null ? (
                    <p className="mt-1 text-sm">
                      <span className="text-muted-foreground">{t("admin.regq.decisionComment")} </span>
                      {row.decision_comment}
                    </p>
                  ) : null}

                  {row.status === "pending" ? (
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setTarget({ row, action: "reject" })}
                        disabled={decide.isPending}
                      >
                        {t("admin.regq.reject")}
                      </Button>
                      <Button
                        onClick={() => setTarget({ row, action: "approve" })}
                        disabled={decide.isPending}
                      >
                        {t("admin.regq.approve")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.regq.footnote")}</Notice>
      </div>

      <ReasonDialog
        open={target !== null}
        title={
          target?.action === "reject"
            ? t("admin.regq.dialog.rejectTitle", {
                name: target !== null ? (personOf(target.row.employee_id)?.name ?? "") : "",
              })
            : t("admin.regq.dialog.approveTitle", {
                name: target !== null ? (personOf(target.row.employee_id)?.name ?? "") : "",
              })
        }
        description={
          target?.action === "reject"
            ? t("admin.regq.dialog.rejectDescription")
            : t("admin.regq.dialog.approveDescription", {
                date: target !== null ? fmtCivilDateWeekday(target.row.ist_date) : "",
              })
        }
        confirmLabel={
          target?.action === "reject"
            ? t("admin.regq.dialog.rejectConfirm")
            : t("admin.regq.dialog.approveConfirm")
        }
        minLength={10}
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={confirm}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
