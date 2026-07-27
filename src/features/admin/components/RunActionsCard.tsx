/**
 * RunActionsCard — the two write actions on a payroll run, and the sentences that
 * explain why one of them is unavailable.
 *
 * THE POINT OF THIS COMPONENT (spec-admin §8.5 gate 4, D-22 four-eyes):
 * the approver must differ from the preparer, and the UI says so BEFORE anybody
 * types anything. `payslip-publish` refuses `approved_by = computed_by` with
 * `PAYROLL_TWO_PERSON_REQUIRED`, and `trg_payroll_runs__two_person` refuses it
 * again inside the transaction — but an operator should never meet either. So the
 * button is disabled, the reason is written in plain English next to it, and the
 * run states who prepared it so the second approver knows who to fetch.
 *
 * Gate 4 also requires the approver to TYPE the net-pay total. The typed figure is
 * compared to `payroll_runs.total_net_paise` exactly, in integer paise, with no
 * tolerance — here first (so a typo is a field error, not a round trip) and then
 * again server-side, which is the real check.
 *
 * `parseRupeesToPaise` (../payroll-input) is the only place this feature turns
 * text into a number. It converts the OPERATOR'S KEYSTROKES into minor units; it
 * never derives a payroll figure from another payroll figure.
 */
import { useState } from "react";
import { CheckCircle2, Lock, Play, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Money } from "@/shared/ui/Money";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { formatPaise } from "@/lib/money";
import { fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { PayrollRun } from "../api/payroll.api";
import {
  APPROVABLE_RUN_STATUSES,
  COMPUTABLE_RUN_STATUSES,
  PAYROLL_RUN_CHIP,
  RELEASED_RUN_STATUSES,
  isVarianceFlagged,
} from "../display";
import { Notice } from "./Notice";
import { TextField } from "./Field";
import { parseRupeesToPaise } from "../payroll-input";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import {
  useComputeRun,
  usePublishRun,
  type RunResult,
} from "../hooks/useAdminPayroll";

type Action = { kind: "compute" } | { kind: "publish"; confirmNetTotalPaise: number };

export interface RunActionsCardProps {
  run: PayrollRun;
  /** Resolved from `computed_by` via `v_admin_employee.profile_id`. */
  preparerName: string | null;
  approverName: string | null;
  reviewerName: string | null;
  /** The signed-in `profiles.id`. Null before the session resolves. */
  myProfileId: string | null;
  actorName: string | null;
  /** `payroll_run_employees` rows in `error` or `held` — they block gate 4. */
  blockingCount: number;
  /** True while the employee list is still loading (blockers not yet known). */
  blockersUnknown: boolean;
}

export function RunActionsCard({
  run,
  preparerName,
  approverName,
  reviewerName,
  myProfileId,
  actorName,
  blockingCount,
  blockersUnknown,
}: RunActionsCardProps) {
  const [typedTotal, setTypedTotal] = useState("");
  const [totalError, setTotalError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const prompt = useReasonPrompt<Action>();
  const { ask, close: closePrompt, target, isOpen } = prompt;

  const compute = useComputeRun((data: RunResult) => {
    closePrompt();
    setNote(
      data.done === false
        ? t("admin.run.compute.partial")
        : t("admin.run.compute.done", { count: data.employee_count ?? 0 }),
    );
  });
  const publish = usePublishRun(() => {
    closePrompt();
    setTypedTotal("");
    setNote(t("admin.run.publish.done", { number: run.run_number }));
  });

  const released = (RELEASED_RUN_STATUSES as readonly string[]).includes(run.status);
  const approvable = (APPROVABLE_RUN_STATUSES as readonly string[]).includes(run.status);
  const computable = (COMPUTABLE_RUN_STATUSES as readonly string[]).includes(run.status);
  const preparerUnknown = run.computed_by === null;
  const isOwnWork = run.computed_by !== null && run.computed_by === myProfileId;

  /** Every reason approval cannot proceed, in the order an operator can act on. */
  const blockers: string[] = [];
  if (!approvable && !released) {
    blockers.push(
      t("admin.run.block.notComputed", { status: PAYROLL_RUN_CHIP[run.status].label }),
    );
  }
  if (approvable && preparerUnknown) blockers.push(t("admin.run.block.noPreparer"));
  if (approvable && isOwnWork) blockers.push(t("admin.run.block.twoPerson"));
  if (approvable && blockingCount > 0) {
    blockers.push(t("admin.run.block.employeeErrors", { count: blockingCount }));
  }
  if (approvable && myProfileId === null) blockers.push(t("admin.run.block.noSession"));

  const canPublish = approvable && blockers.length === 0 && !blockersUnknown;
  const pending = compute.isPending || publish.isPending;

  function startPublish(): void {
    const paise = parseRupeesToPaise(typedTotal);
    if (paise === null) {
      setTotalError(t("admin.run.publish.totalInvalid"));
      return;
    }
    if (paise !== run.total_net_paise) {
      setTotalError(
        t("admin.run.publish.totalMismatch", { total: formatPaise(run.total_net_paise) }),
      );
      return;
    }
    setTotalError(null);
    publish.reset();
    ask({ kind: "publish", confirmNetTotalPaise: paise });
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="font-display text-lg font-semibold">{t("admin.run.actions.heading")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.run.actions.hint")}</p>

      {note !== null ? (
        <Notice tone="success" className="mt-4">
          {note}
        </Notice>
      ) : null}

      {/* Who did what — the four-eyes ledger, in words. */}
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.run.people.preparer")}
          </dt>
          <dd className="mt-0.5 text-sm">
            {preparerUnknown
              ? t("admin.run.people.notNamed")
              : preparerName ?? t("admin.run.people.notOnDirectory")}
            <span className="block text-xs text-muted-foreground">
              {dash(run.computed_at, fmtDateTime)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.run.people.reviewer")}
          </dt>
          <dd className="mt-0.5 text-sm">
            {run.reviewed_by === null
              ? t("admin.common.notYet")
              : reviewerName ?? t("admin.run.people.notOnDirectory")}
            <span className="block text-xs text-muted-foreground">
              {dash(run.reviewed_at, fmtDateTime)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.run.people.approver")}
          </dt>
          <dd className="mt-0.5 text-sm">
            {run.approved_by === null
              ? t("admin.common.notYet")
              : approverName ?? t("admin.run.people.notOnDirectory")}
            <span className="block text-xs text-muted-foreground">
              {dash(run.approved_at, fmtDateTime)}
            </span>
          </dd>
        </div>
      </dl>

      {isOwnWork ? (
        <Notice tone="warning" className="mt-4">
          <p className="font-medium">{t("admin.run.twoPerson.title")}</p>
          <p className="mt-1">{t("admin.run.twoPerson.body")}</p>
        </Notice>
      ) : null}

      {isVarianceFlagged(run.variance_vs_previous_pct) ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.run.varianceAck")}
        </Notice>
      ) : null}

      {released ? (
        <Notice tone="success" className="mt-4">
          {t("admin.run.alreadyReleased", { status: PAYROLL_RUN_CHIP[run.status].label })}
        </Notice>
      ) : null}

      {/* Gate 4 + 5 */}
      {!released ? (
        <div className="mt-5 rounded-md border border-dashed p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t("admin.run.publish.heading")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.run.publish.hint")}
          </p>
          <p className="mt-3 text-sm">
            {t("admin.run.publish.netLabel")}{" "}
            <Money paise={run.total_net_paise} className="font-semibold" />
          </p>

          <div className="mt-3 max-w-xs">
            <TextField
              label={t("admin.run.publish.totalField")}
              value={typedTotal}
              onChange={(value) => {
                setTypedTotal(value);
                setTotalError(null);
              }}
              inputMode="decimal"
              placeholder={formatPaise(run.total_net_paise)}
              disabled={!approvable || pending}
              hint={t("admin.run.publish.totalHint")}
              {...(totalError !== null ? { error: totalError } : {})}
            />
          </div>

          {blockers.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              {blockers.map((blocker) => (
                <li key={blocker} className="flex items-start gap-2">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{blocker}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <Button className="mt-4" onClick={startPublish} disabled={!canPublish || pending}>
            {publish.isPending
              ? t("admin.run.publish.pending")
              : t("admin.run.publish.action")}
          </Button>
        </div>
      ) : null}

      {/* Gates 1–2 */}
      {computable ? (
        <div className="mt-4 rounded-md border border-dashed p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Play className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t("admin.run.compute.heading")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.run.compute.hint")}</p>
          <Button
            variant="outline"
            className="mt-3"
            disabled={pending}
            onClick={() => {
              compute.reset();
              ask({ kind: "compute" });
            }}
          >
            {compute.isPending ? t("admin.run.compute.pending") : t("admin.run.compute.action")}
          </Button>
        </div>
      ) : null}

      {blockersUnknown ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" aria-hidden />
          {t("admin.run.block.checking")}
        </p>
      ) : null}

      <ReasonDialog
        open={isOpen}
        title={
          target?.kind === "publish"
            ? t("admin.run.dialog.publishTitle", { number: run.run_number })
            : t("admin.run.dialog.computeTitle", { number: run.run_number })
        }
        description={
          target?.kind === "publish"
            ? t("admin.run.dialog.publishDescription", {
                total: formatPaise(run.total_net_paise),
              })
            : t("admin.run.dialog.computeDescription")
        }
        actorName={actorName}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={
          target?.kind === "publish"
            ? t("admin.run.publish.action")
            : t("admin.run.compute.action")
        }
        pending={pending}
        errorMessage={target?.kind === "publish" ? publish.userMessage : compute.userMessage}
        onConfirm={(reason) => {
          if (target === null) return;
          if (target.kind === "publish") {
            publish.save(
              {
                payrollRunId: run.id,
                runNumber: run.run_number,
                confirmNetTotalPaise: target.confirmNetTotalPaise,
              },
              reason,
            );
            return;
          }
          compute.save({ payrollRunId: run.id, runNumber: run.run_number }, reason);
        }}
        onCancel={() => {
          compute.reset();
          publish.reset();
          closePrompt();
        }}
      />
    </section>
  );
}
