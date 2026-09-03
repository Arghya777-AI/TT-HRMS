/**
 * ApprovalEvidence — what the approver is actually approving.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The Approval Inbox's detail panel showed the request's ENVELOPE — dates, days, an amount,
 * the SLA clock and the action trail — and never the request. HR, on a reimbursement: "I can
 * see only the amount. There is no Excel, no attachment, nothing is there." On an attendance
 * regularisation: "I'm not able to see any details — just given the request and it is showing
 * nothing. I just approved it."
 *
 * Both were approving blind, and the panel had the address the whole time:
 * `approval_requests.detail_table` and `detail_id` are on the row and are already passed to
 * `act_on_approval`. Nothing read them.
 *
 * ── NOT A PERMISSION PROBLEM, CHECKED ───────────────────────────────────────
 * Every admin can read these rows — `documents__admin__all`, the documents storage policy,
 * and the regularisation table's own policies, verified by impersonating each live
 * administrator under RLS. Every read below runs under the caller's token, so RLS still
 * decides; a row that does not come back is reported as unreadable rather than as absent.
 *
 * ── ONE COMPONENT, SWITCHED ON `detail_table` ───────────────────────────────
 * Keyed on the column the database uses, not on the request-type CODE. `detail_table` is what
 * `act_on_approval` dispatches on, so the panel and the decision agree by construction. A
 * type with no block yet says so plainly instead of rendering an empty box.
 */
import { useQuery } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Money } from "@/shared/ui/Money";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  attachReceipts,
  fetchClaimLines,
  fetchClaimReceipts,
  type ClaimLineWithReceipt,
} from "../api/claimEvidence.api";
import { fetchRegularizationsByIds } from "../api/regularizations-admin.api";
import type { Regularization } from "@/features/attendance/api/regularizations.api";

/** The detail tables this panel can open. Anything else says so rather than rendering blank. */
const CLAIM_TABLE = "reimbursement_claims";
const REGULARIZATION_TABLE = "attendance_regularizations";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function ClaimBlock({ rows }: { rows: readonly ClaimLineWithReceipt[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("admin.wf.ev.claim.noLines")}</p>;
  }
  return (
    <ul className="space-y-3">
      {rows.map(({ line, receipt }) => (
        <li key={line.id} className="rounded-md border p-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Fact label={t("admin.reimb.ev.f.date")}>{fmtCivilDate(line.line_date)}</Fact>
            <Fact label={t("admin.reimb.ev.f.head")}>{dash(line.expense_head)}</Fact>
            <Fact label={t("admin.reimb.ev.f.claimed")}>
              <Money paise={line.amount_claimed_paise} />
            </Fact>
            {line.from_location !== null || line.to_location !== null ? (
              <>
                <Fact label={t("admin.reimb.ev.f.from")}>{dash(line.from_location)}</Fact>
                <Fact label={t("admin.reimb.ev.f.to")}>{dash(line.to_location)}</Fact>
              </>
            ) : null}
            {line.distance_km !== null ? (
              <Fact label={t("admin.reimb.ev.f.distance")}>
                {t("admin.reimb.ev.km", { km: formatNumber(line.distance_km) })}
              </Fact>
            ) : null}
            {line.gst_number !== null ? (
              <Fact label={t("admin.reimb.ev.f.gst")}>{line.gst_number}</Fact>
            ) : null}
            <div className="col-span-2 sm:col-span-3">
              <Fact label={t("admin.reimb.ev.f.desc")}>{dash(line.description)}</Fact>
            </div>
          </dl>
          <div className="mt-3 flex items-start justify-between gap-3 border-t pt-3">
            <p className="min-w-0 break-words text-xs">
              {/*
                THE THREE ABSENCES, kept apart here exactly as on the payroll register: a
                receipt this reader may not open is a bill that EXISTS, and calling it "none
                attached" would tell an approver the employee filed nothing.
              */}
              {receipt !== null ? (
                <span className="inline-flex items-center gap-1.5">
                  <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
                  {dash(receipt.file_name ?? receipt.title)}
                </span>
              ) : line.receipt_document_id !== null ? (
                <span className="text-amber-700 dark:text-amber-400">
                  {t("admin.reimb.ev.billUnreadable")}
                </span>
              ) : line.is_receipt_required ? (
                <span className="text-destructive">{t("admin.reimb.ev.noBillRequired")}</span>
              ) : (
                <span className="text-muted-foreground">{t("admin.reimb.ev.noBill")}</span>
              )}
            </p>
            {receipt !== null ? (
              <DocumentOpenButtons
                documentId={receipt.id}
                title={receipt.file_name ?? receipt.title}
                variant="icon"
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RegularizationBlock({ reg }: { reg: Regularization }) {
  return (
    <div className="rounded-md border p-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Fact label={t("admin.wf.ev.reg.date")}>{fmtCivilDate(reg.ist_date)}</Fact>
        <Fact label={t("admin.wf.ev.reg.kind")}>{reg.regularization_kind}</Fact>
        <Fact label={t("admin.wf.ev.reg.quota", { n: formatNumber(reg.month_quota_counter) })}>
          {dash(reg.created_at, fmtDateTime)}
        </Fact>
        {/* THE TIMES. Absent from the panel entirely before this — an approver was asked to
            accept a correction to somebody's attendance without seeing the correction. */}
        <Fact label={t("admin.wf.ev.reg.in")}>{dash(reg.requested_first_in_at, fmtDateTime)}</Fact>
        <Fact label={t("admin.wf.ev.reg.out")}>{dash(reg.requested_last_out_at, fmtDateTime)}</Fact>
        <Fact label={t("admin.wf.ev.reg.status")}>{dash(reg.requested_status)}</Fact>
        <div className="col-span-2 sm:col-span-3">
          <Fact label={t("admin.wf.ev.reg.reason")}>{reg.employee_reason}</Fact>
        </div>
      </dl>

      <div className="mt-3 flex items-start justify-between gap-3 border-t pt-3">
        <div className="min-w-0">
          <p className="text-xs">
            {reg.applied_at !== null ? (
              <span>
                {t("admin.wf.ev.reg.applied")} · {fmtDateTime(reg.applied_at)}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("admin.wf.ev.reg.notApplied")}</span>
            )}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t("admin.wf.ev.reg.appliedHint")}
          </p>
          {reg.supporting_document_id === null ? (
            <p className="mt-1 text-xs text-muted-foreground">{t("admin.wf.ev.reg.noProof")}</p>
          ) : null}
        </div>
        {reg.supporting_document_id !== null ? (
          <div className="shrink-0">
            <p className="mb-1 text-right text-xs text-muted-foreground">
              {t("admin.wf.ev.reg.proof")}
            </p>
            <DocumentOpenButtons documentId={reg.supporting_document_id} variant="icon" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface ApprovalEvidenceProps {
  readonly detailTable: string;
  readonly detailId: string;
}

export function ApprovalEvidence({ detailTable, detailId }: ApprovalEvidenceProps) {
  const supported = detailTable === CLAIM_TABLE || detailTable === REGULARIZATION_TABLE;

  const evidence = useQuery({
    queryKey: qk.admin.payslips({ part: "approval-evidence", detailTable, detailId }),
    enabled: supported,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }) => {
      if (detailTable === CLAIM_TABLE) {
        const lines = await fetchClaimLines([detailId], signal);
        const receipts = await fetchClaimReceipts(lines, signal);
        return { kind: "claim" as const, rows: attachReceipts(lines, receipts) };
      }
      const regs = await fetchRegularizationsByIds([detailId], signal);
      return { kind: "regularization" as const, reg: regs[0] ?? null };
    },
  });

  if (!supported) {
    return (
      <section className="mt-4">
        <h3 className="mb-2 text-sm font-semibold">{t("admin.wf.ev.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("admin.wf.ev.none")}</p>
      </section>
    );
  }

  return (
    <section className="mt-4">
      <h3 className="mb-2 text-sm font-semibold">{t("admin.wf.ev.title")}</h3>
      <StateBoundary
        loading={evidence.isPending}
        error={evidence.error}
        onRetry={() => void evidence.refetch()}
      >
        {evidence.data === undefined ? null : evidence.data.kind === "claim" ? (
          <ClaimBlock rows={evidence.data.rows} />
        ) : evidence.data.reg === null ? (
          /*
            The row exists — the approval names it — and RLS did not return it. That is an
            access outcome, not an empty request, and it must not read as "no details".
          */
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t("admin.wf.ev.unreadable")}
          </p>
        ) : (
          <RegularizationBlock reg={evidence.data.reg} />
        )}
      </StateBoundary>
    </section>
  );
}
