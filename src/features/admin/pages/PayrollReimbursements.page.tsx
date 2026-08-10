/**
 * §8 · /admin/payroll/reimbursements — claims cleared for payment with payroll.
 *
 * The register is `reimbursement_claims` (migration 024) and the four slices are
 * PREDICATES on its own columns, because "cleared for payment with payroll" is not
 * an opinion: `compute_payslip` picks up a claim when `status = 'approved'` AND
 * `paid_via_payroll_run_id` is this run, and writes `total_approved_paise` as a
 * `reimbursement` payslip line. So:
 *
 *   awaiting  — pending / in_progress / escalated
 *   routed    — approved AND attached to a run   → the run WILL pay it
 *   unrouted  — approved AND attached to no run  → approved money that no run will
 *               pay until someone attaches it. This is the slice that matters.
 *   paid      — `paid_on` is set
 *
 * DECIDING goes through `public.act_on_approval` — the single client-facing action
 * RPC — and only for claims where the SERVER says the signed-in person is the
 * current approver (`v_approval_inbox` already filters to
 * `current_employee_id() = ANY (current_approver_ids)`). Rows outside that set
 * show no buttons at all; an admin is not silently promoted into an approval chain
 * they are not on.
 *
 * The honest gap is stated on screen: nothing deployed applies a settled approval
 * back onto `reimbursement_claims` (no trigger, and `approval_requests.applied_at`
 * is never written), so after a decision the claim's own `status` still reads
 * `pending` until an admin or a job moves it. The decision IS recorded — in
 * `approval_actions`, immutably — and the banner says exactly that rather than
 * claiming a payment state that did not change.
 *
 * Money is integer paise via `<Money>`; not one amount is added up here.
 *
 * @route /admin/payroll/reimbursements
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Banknote, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { type MessageKey, t } from "@/shared/i18n/en";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { useAuditedMutation } from "@/shared/hooks/useAuditedMutation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { CountTile } from "../components/CountTile";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useClaimDecisionTargets,
  useDecideClaim,
  useReimbursementClaimCount,
  useReimbursementClaims,
} from "../hooks/usePayrollStatutory";
import {
  claimPaymentModeValues,
  countEmployeesWithoutManager,
  recordClaimPayment,
  type ClaimPaymentMode,
  type ClaimPaymentResult,
  type RecordClaimPaymentInput,
  CLAIM_TYPES,
  REGISTER_ROW_CAP,
  isClaimSlice,
  isClaimType,
  type ClaimSlice,
  type ClaimType,
  type ReimbursementClaim,
} from "../api/payroll-statutory.api";

/** `public.approval_status` — the words the DB stores, in the words HR uses. */
const CLAIM_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.reimb.status.draft"), tone: "neutral" },
  pending: { label: t("admin.reimb.status.pending"), tone: "warn" },
  in_progress: { label: t("admin.reimb.status.inProgress"), tone: "warn" },
  escalated: { label: t("admin.reimb.status.escalated"), tone: "danger" },
  approved: { label: t("admin.reimb.status.approved"), tone: "success" },
  auto_approved: { label: t("admin.reimb.status.autoApproved"), tone: "success" },
  applied: { label: t("admin.reimb.status.applied"), tone: "success" },
  rejected: { label: t("admin.reimb.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.reimb.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.reimb.status.withdrawn"), tone: "neutral" },
  expired: { label: t("admin.reimb.status.expired"), tone: "neutral" },
  failed: { label: t("admin.reimb.status.failed"), tone: "danger" },
};

function claimTypeLabel(claimType: ClaimType): string {
  switch (claimType) {
    case "local_conveyance":
      return t("admin.reimb.type.localConveyance");
    case "travel":
      return t("admin.reimb.type.travel");
    case "food":
      return t("admin.reimb.type.food");
    case "medical":
      return t("admin.reimb.type.medical");
    case "telephone":
      return t("admin.reimb.type.telephone");
    case "uniform":
      return t("admin.reimb.type.uniform");
    case "fuel":
      return t("admin.reimb.type.fuel");
    case "guest_hospitality":
      return t("admin.reimb.type.guestHospitality");
    case "misc":
      return t("admin.reimb.type.misc");
  }
}

const SLICE_TILES: readonly { slice: ClaimSlice; label: string; hint: string }[] = [
  {
    slice: "awaiting",
    label: t("admin.reimb.tile.awaiting"),
    hint: t("admin.reimb.tile.awaitingHint"),
  },
  {
    slice: "unrouted",
    label: t("admin.reimb.tile.unrouted"),
    hint: t("admin.reimb.tile.unroutedHint"),
  },
  {
    slice: "routed",
    label: t("admin.reimb.tile.routed"),
    hint: t("admin.reimb.tile.routedHint"),
  },
  { slice: "paid", label: t("admin.reimb.tile.paid"), hint: t("admin.reimb.tile.paidHint") },
];

type DecisionTarget = { row: ReimbursementClaim; decision: "approve" | "reject" };

export default function PayrollReimbursementsPage() {
  const [params, setParams] = useSearchParams();
  const sliceParam = params.get("slice");
  const slice: ClaimSlice | null = isClaimSlice(sliceParam) ? sliceParam : null;
  const typeParam = params.get("type");
  const claimType: ClaimType | null =
    typeParam !== null && isClaimType(typeParam) ? typeParam : null;

  const filters = useMemo(() => ({ slice, claimType }), [slice, claimType]);

  const claims = useReimbursementClaims(filters);
  const rows = useMemo(() => claims.data ?? [], [claims.data]);
  const matching = useReimbursementClaimCount(filters);
  const labels = useEmployeeLabels();
  const targets = useClaimDecisionTargets();
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const [payTarget, setPayTarget] = useState<ReimbursementClaim | null>(null);
  const [payMode, setPayMode] = useState<ClaimPaymentMode>("bank_transfer");
  const [payDate, setPayDate] = useState<string>(nowIstDate());
  const [payReference, setPayReference] = useState("");
  const [payDone, setPayDone] = useState<string | null>(null);
  const [payConfirm, setPayConfirm] = useState(false);

  /*
    Level 1 of the claim chain is `reporting_manager`. When an employee has none,
    `resolve_approvers` falls back to hr_admin — so the claim lands here, on this
    screen, instead of with the person who knows whether the trip happened. The
    count belongs where the consequence is felt.
  */
  const noManager = useQuery({
    queryKey: qk.admin.employees({ scope: "without-manager" }),
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => countEmployeesWithoutManager(signal),
  });

  const pay = useAuditedMutation<ClaimPaymentResult | null, RecordClaimPaymentInput>({
    mutationFn: (input, reason) => recordClaimPayment(input, reason),
    invalidate: [qk.admin.payrollAll(), qk.admin.employeesAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
  const [dismissed, setDismissed] = useState(false);
  const decide = useDecideClaim(() => setDismissed(false));

  const counts: Record<ClaimSlice, ReturnType<typeof useReimbursementClaimCount>> = {
    awaiting: useReimbursementClaimCount({ slice: "awaiting", claimType }),
    unrouted: useReimbursementClaimCount({ slice: "unrouted", claimType }),
    routed: useReimbursementClaimCount({ slice: "routed", claimType }),
    paid: useReimbursementClaimCount({ slice: "paid", claimType }),
  };

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const labelMap = labels.data;
  const targetMap = targets.data;

  const confirm = (reason: string): void => {
    if (target === null) return;
    const decidable = targetMap?.get(target.row.id);
    if (decidable === undefined) return;
    decide.save(
      {
        claimId: target.row.id,
        claimNumber: target.row.claim_number,
        approvalRequestId: decidable.approvalRequestId,
        requestNumber: decidable.requestNumber,
        decision: target.decision,
      },
      // One typed sentence, two audiences: the audit reason AND the decision
      // comment the claimant reads on their own claim.
      reason,
    );
    setTarget(null);
  };

  const result = decide.data;
  const outcome =
    result === undefined
      ? null
      : result.notAppliedReason === "chain_continues"
        ? t("admin.reimb.outcome.chain", {
            number: result.approval.request_number,
            level: formatNumber(result.approval.current_level),
          })
        : t("admin.reimb.outcome.recorded", {
            number: result.approval.request_number,
            // The chain's settled state in HR's words — never the raw enum.
            status:
              CLAIM_STATUS_CHIP[result.approval.status]?.label ??
              t("admin.reimb.outcome.settled"),
          });

  const columns: DataGridColumn<ReimbursementClaim>[] = useMemo(
    () => [
      {
        key: "claim_number",
        header: t("admin.reimb.col.claim"),
        width: "12rem",
        sortable: true,
        render: (row) => <span className="num font-medium">{row.claim_number}</span>,
      },
      {
        key: "employee",
        header: t("admin.reimb.col.employee"),
        width: "15rem",
        render: (row) => {
          const who = labelMap?.get(row.employee_id);
          return (
            <PersonCell
              name={who?.name ?? null}
              code={who?.code ?? null}
              secondary={who?.department ?? null}
            />
          );
        },
      },
      {
        key: "claim_type",
        header: t("admin.reimb.col.type"),
        width: "11rem",
        hideBelow: "md",
        render: (row) => (
          <span>{isClaimType(row.claim_type) ? claimTypeLabel(row.claim_type) : dash(null)}</span>
        ),
      },
      {
        key: "period",
        header: t("admin.reimb.col.period"),
        width: "12rem",
        hideBelow: "lg",
        render: (row) =>
          row.period_from === null && row.period_to === null ? (
            dash(null)
          ) : (
            <span className="num text-xs">
              {t("admin.common.dateRange", {
                from: dash(row.period_from, fmtCivilDate),
                to: dash(row.period_to, fmtCivilDate),
              })}
            </span>
          ),
      },
      {
        key: "total_claimed_paise",
        header: t("admin.reimb.col.claimed"),
        width: "10rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_claimed_paise} />,
      },
      {
        key: "total_approved_paise",
        header: t("admin.reimb.col.approved"),
        width: "10rem",
        align: "right",
        render: (row) => <Money paise={row.total_approved_paise} className="font-medium" />,
      },
      {
        key: "advance_adjusted_paise",
        header: t("admin.reimb.col.advance"),
        width: "10rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => <Money paise={row.advance_adjusted_paise} />,
      },
      {
        key: "status",
        header: t("admin.reimb.col.status"),
        width: "10rem",
        render: (row) => <StatusChip status={row.status} map={CLAIM_STATUS_CHIP} />,
      },
      {
        key: "routing",
        header: t("admin.reimb.col.routing"),
        width: "12rem",
        hideBelow: "md",
        render: (row) =>
          row.paid_on !== null ? (
            <span className="text-xs">
              {t("admin.reimb.routing.paid", { on: fmtCivilDate(row.paid_on) })}
            </span>
          ) : row.paid_via_payroll_run_id !== null ? (
            <span className="text-xs">{t("admin.reimb.routing.inRun")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("admin.reimb.routing.noRun")}
            </span>
          ),
      },
      {
        key: "decide",
        header: t("admin.reimb.col.decide"),
        width: "13rem",
        align: "right",
        render: (row) => {
          const decidable = targetMap?.get(row.id);
          /*
            An approved claim that has not been paid is the one case where the
            action is NOT an approval. It appears here rather than in its own
            column because a row is only ever in one of the two states — waiting
            for a decision, or waiting for the money — and two columns would
            leave one of them permanently empty.
          */
          if (decidable === undefined) {
            if (row.status === "approved" && row.paid_on === null) {
              return (
                <span className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => setPayTarget(row)}>
                    {t("claim.pay.action")}
                  </Button>
                </span>
              );
            }
            return <span className="text-xs text-muted-foreground">{dash(null)}</span>;
          }
          return (
            <span className="flex flex-col items-end gap-1">
              {/*
                An override is labelled, never silent. This administrator is not
                the current approver — they can act only because the request ran
                past the SLA the employee was shown when they filed it. Making it
                look like an ordinary approval is how a manager's step quietly
                stops mattering.
              */}
              {decidable.isOverride ? (
                <span className="text-[11px] text-warning">
                  {t("claim.override.badge", {
                    on: decidable.slaDueAt === null ? "" : fmtCivilDate(decidable.slaDueAt.slice(0, 10)),
                  })}
                </span>
              ) : null}
              <span className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={decide.isPending}
                onClick={() => setTarget({ row, decision: "reject" })}
              >
                {t("admin.reimb.reject")}
              </Button>
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() => setTarget({ row, decision: "approve" })}
              >
                {t("admin.reimb.approve")}
              </Button>
              </span>
            </span>
          );
        },
      },
    ],
    [labelMap, targetMap, decide.isPending],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.reimb.title")}
        subtitle={t("admin.reimb.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.reimb.gap.applyPath")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.reimb.filter.slice")}
          value={slice ?? ""}
          options={SLICE_TILES.map((tile) => ({ value: tile.slice, label: tile.label }))}
          placeholder={t("admin.reimb.filter.allClaims")}
          onChange={(value) => setParam("slice", value)}
        />
        <SelectField
          label={t("admin.reimb.filter.type")}
          value={claimType ?? ""}
          options={CLAIM_TYPES.map((type) => ({ value: type, label: claimTypeLabel(type) }))}
          placeholder={t("admin.reimb.filter.allTypes")}
          onChange={(value) => setParam("type", value)}
        />
        <div className="flex items-end">
          <p className="text-sm text-muted-foreground">
            {matching.isSuccess
              ? t("admin.reimb.matching", { n: formatNumber(matching.data) })
              : t("admin.reimb.matchingUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SLICE_TILES.map((tile) => (
          <CountTile
            key={tile.slice}
            label={tile.label}
            hint={tile.hint}
            to={`/admin/payroll/reimbursements?slice=${tile.slice}`}
            drillLabel={tile.label}
            source={t("admin.reimb.source.register")}
            query={counts[tile.slice]}
          />
        ))}
      </div>

      {outcome !== null && !dismissed ? (
        <div className="mt-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
                {t("admin.common.dismiss")}
              </Button>
            }
          >
            {outcome}
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
          loading={claims.isPending}
          error={claims.error}
          onRetry={() => void claims.refetch()}
          partialError={labels.error ?? targets.error}
          partialLabel={t("admin.reimb.partial")}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Receipt}
              title={t("admin.reimb.empty.title")}
              hint={
                slice !== null || claimType !== null
                  ? t("admin.reimb.empty.filtered")
                  : t("admin.reimb.empty.hint")
              }
            />
          }
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
          {rows.length >= REGISTER_ROW_CAP ? (
            <div className="mt-3">
              <Notice tone="warning">
                {t("admin.common.rowCap", { count: formatNumber(REGISTER_ROW_CAP) })}
              </Notice>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      {/*
        The org-chart gap, on the screen that receives its consequences. Every
        one of these people has claims routed to an administrator because
        `resolve_approvers` could not find them a manager — not a silent
        fallback, a visible one, so it gets fixed rather than absorbed.
      */}
      {noManager.isSuccess && noManager.data > 0 ? (
        <div className="mb-4">
          <Notice tone="warning">
            <p className="font-medium">
              {t("claim.noManager.title", { n: formatNumber(noManager.data) })}
            </p>
            <p className="mt-1">{t("claim.noManager.hint")}</p>
          </Notice>
        </div>
      ) : null}

      {payDone !== null ? (
        <div className="mb-4">
          <Notice tone="success">{t("claim.pay.done", { ref: payDone })}</Notice>
        </div>
      ) : null}

      {/*
        The payment's own fields sit in a panel, not in the dialog: `ReasonDialog`
        collects a sentence and nothing else, by design — it is the one place an
        audited write asks "why", and giving it a form would make it two things.
        So the admin fills these in, then confirms with a reason.
      */}
      {payTarget !== null ? (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <p className="font-medium">
            {t("claim.pay.title", { ref: payTarget.claim_number })}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="pay-mode">{t("claim.pay.mode")}</Label>
              <select
                id="pay-mode"
                value={payMode}
                onChange={(e) => setPayMode(e.target.value as ClaimPaymentMode)}
                className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {claimPaymentModeValues.map((value) => (
                  <option key={value} value={value}>
                    {t(`claim.pay.mode.${value}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pay-date">{t("claim.pay.date")}</Label>
              <Input
                id="pay-date"
                type="date"
                max={nowIstDate()}
                className="mt-1.5 h-10"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pay-ref">{t("claim.pay.reference")}</Label>
              <Input
                id="pay-ref"
                className="mt-1.5 h-10"
                value={payReference}
                onChange={(e) => setPayReference(e.target.value)}
              />
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{t("claim.pay.referenceHint")}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPayTarget(null)}>
              {t("admin.master.cancel")}
            </Button>
            <Button size="sm" onClick={() => setPayConfirm(true)}>
              {t("claim.pay.action")}
            </Button>
          </div>
        </div>
      ) : null}

      {/*
        `record_claim_payment` refuses a claim that is not approved, one already
        paid, a future date, and a non-cash payment with no reference — each with
        its own sentence, surfaced here unchanged.
      */}
      <ReasonDialog
        open={payConfirm && payTarget !== null}
        title={t("claim.pay.title", { ref: payTarget?.claim_number ?? "" })}
        confirmLabel={t("claim.pay.action")}
        minLength={pay.minReasonLength}
        pending={pay.isPending}
        errorMessage={pay.userMessage}
        onCancel={() => setPayConfirm(false)}
        onConfirm={(reason) => {
          const row = payTarget;
          if (row === null) return;
          pay.save(
            {
              claimId: row.id,
              mode: payMode,
              paidOn: payDate,
              reference: payReference.trim() === "" ? null : payReference.trim(),
            },
            reason,
          );
          setPayConfirm(false);
          setPayDone(row.claim_number);
          setPayTarget(null);
          setPayReference("");
        }}
      />


      <ReasonDialog
        open={target !== null}
        title={
          target?.decision === "reject"
            ? t("admin.reimb.dialog.rejectTitle", { number: target?.row.claim_number ?? "" })
            : t("admin.reimb.dialog.approveTitle", { number: target?.row.claim_number ?? "" })
        }
        description={
          target?.decision === "reject"
            ? t("admin.reimb.dialog.rejectDescription")
            : t("admin.reimb.dialog.approveDescription")
        }
        confirmLabel={
          target?.decision === "reject"
            ? t("admin.reimb.dialog.rejectConfirm")
            : t("admin.reimb.dialog.approveConfirm")
        }
        minLength={decide.minReasonLength}
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={confirm}
        onCancel={() => setTarget(null)}
      />

      <div className="mt-6">
        <Notice tone="info">{t("admin.reimb.footnote")}</Notice>
      </div>
    </div>
  );
}
