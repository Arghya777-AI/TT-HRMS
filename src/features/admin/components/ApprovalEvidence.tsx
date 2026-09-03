/**
 * ApprovalEvidence — everything the employee submitted, on the approver's screen.
 *
 * ── WHAT HR SAID, TWICE ─────────────────────────────────────────────────────
 * "If I go for an approval, I can see only the amount. There is no Excel, no attachment,
 * nothing is there." And: "No details are showing properly. Every detail should be coming —
 * images, what they applied for, what is the reason, and at what time they applied. Right now
 * only the times are coming, but not the reason or the purpose. If they have attached a
 * document or not, nothing is coming."
 *
 * All of it accurate. The Approval Inbox rendered `approval_requests` — dates, days, an
 * amount, the SLA clocks — and never opened the row it names through `detail_table` /
 * `detail_id`. Those two columns are already handed to `act_on_approval` when the decision is
 * taken; nothing read them to show what the decision was about. A leave request therefore
 * showed no reason, and `leave_requests.supporting_document_id` had no reader anywhere.
 *
 * ── ONE PANEL FOR ALL 19 TYPES ──────────────────────────────────────────────
 * `approval_request_evidence` (migration 20260903120000) returns whatever the detail row holds
 * minus plumbing, plus every attachment id, plus child rows for a claim. So this renders a
 * request type it has never heard of — which is the property that stops the fourteenth type
 * shipping blank. `evidenceFields.ts` decides order and formatting and is tested on its own.
 *
 * ── NOT A PERMISSION PROBLEM, AND NOT RE-IMPLEMENTED HERE ───────────────────
 * The function is SECURITY INVOKER, so RLS decides what comes back. `readable: false` means
 * the row exists and this approver may not read it — rendered as exactly that, never as "no
 * details", because telling an approver an employee submitted nothing is worse than telling
 * them they cannot see it.
 */
import { useQuery } from "@tanstack/react-query";
import { FileWarning, Paperclip, ShieldAlert } from "lucide-react";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Money } from "@/shared/ui/Money";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import { en } from "@/shared/i18n/en";
import {
  evidenceValueKind,
  humaniseKey,
  isWideField,
  orderEvidenceKeys,
} from "../evidenceFields";
import { fetchApprovalEvidence } from "../api/approvalEvidence.api";

/**
 * A translated label when the catalogue has one, otherwise the humanised key.
 *
 * `t()` has NO missing-key fallback — `en[key]` is undefined and `t` returns it unchanged — so
 * membership is checked against the catalogue before calling it. Building the key by template
 * and hoping is how a cell renders empty.
 */
function fieldLabel(key: string): string {
  const messageKey = `admin.wf.ev.f.${key}`;
  return Object.prototype.hasOwnProperty.call(en, messageKey)
    ? t(messageKey as MessageKey)
    : humaniseKey(key);
}

function EvidenceValue({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  switch (evidenceValueKind(fieldKey, value)) {
    case "money":
      return <Money paise={value as number} />;
    case "instant":
      return <>{fmtDateTime(value as string)}</>;
    case "date":
      return <>{fmtCivilDate(value as string)}</>;
    case "boolean":
      return <>{value === true ? t("common.yes") : t("common.no")}</>;
    default:
      // Objects and arrays that reached here are shown as JSON rather than "[object Object]".
      return <>{typeof value === "object" ? JSON.stringify(value) : String(value)}</>;
  }
}

function FieldGrid({ fields }: { fields: Record<string, unknown> }) {
  const keys = orderEvidenceKeys(Object.keys(fields));
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("admin.wf.ev.noFields")}</p>;
  }
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {keys.map((key) => {
        const value = fields[key];
        return (
          <div
            key={key}
            className={isWideField(key, value) ? "min-w-0 sm:col-span-2 lg:col-span-3" : "min-w-0"}
          >
            <dt className="text-xs text-muted-foreground">{fieldLabel(key)}</dt>
            <dd className="break-words text-sm">
              <EvidenceValue fieldKey={key} value={value} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export interface ApprovalEvidenceProps {
  readonly approvalRequestId: string;
}

export function ApprovalEvidence({ approvalRequestId }: ApprovalEvidenceProps) {
  const evidence = useQuery({
    queryKey: qk.admin.payslips({ part: "approval-evidence", approvalRequestId }),
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchApprovalEvidence(approvalRequestId, signal),
  });

  return (
    <section className="mt-4" aria-label={t("admin.wf.ev.title")}>
      <h3 className="mb-2 text-sm font-semibold">{t("admin.wf.ev.title")}</h3>
      <StateBoundary
        loading={evidence.isPending}
        error={evidence.error}
        onRetry={() => void evidence.refetch()}
      >
        {(() => {
          const data = evidence.data;
          if (data === undefined || data === null || !data.found) {
            return <p className="text-sm text-muted-foreground">{t("admin.wf.ev.none")}</p>;
          }
          if (data.unknown_table) {
            // A detail_table with no registered request type. Schema drift, said out loud.
            return (
              <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("admin.wf.ev.unknownTable", { table: data.detail_table ?? "" })}
              </p>
            );
          }
          if (!data.readable) {
            /*
              THE DISTINCTION THAT MATTERS. The row exists — this approval names it — and RLS
              did not return it. "No details" would tell an approver the employee submitted
              nothing while they decide money or somebody's attendance.
            */
            return (
              <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t("admin.wf.ev.unreadable")}
              </p>
            );
          }

          return (
            <div className="space-y-4">
              <div className="rounded-md border p-3">
                <FieldGrid fields={data.fields} />
              </div>

              {/* Child rows. A claim keeps its money on `claim_lines`, so the header alone
                  showed an approver a total with nothing behind it. */}
              {data.lines.length > 0 ? (
                <div>
                  <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {t("admin.wf.ev.claim.lines")}
                  </h4>
                  <ul className="space-y-2">
                    {data.lines.map((line, i) => (
                      <li key={String(line["id"] ?? i)} className="rounded-md border p-3">
                        <FieldGrid fields={line} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* ── THE ATTACHMENTS ─────────────────────────────────────────
                  "If they have attached a document or not, nothing is coming." Every
                  attachment on the row, opened through `document-access`, which logs the
                  access before the URL exists. Absence is stated rather than left blank —
                  an approver needs to know a request came WITHOUT proof. */}
              <div>
                <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("admin.wf.ev.docs")}
                </h4>
                {data.documents.length === 0 ? (
                  <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs">
                    <FileWarning className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {t("admin.wf.ev.noDocs")}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.documents.map((id, i) => (
                      <li key={id} className="flex items-center justify-between gap-3 rounded-md border p-2">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
                          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          {t("admin.wf.ev.docN", { n: String(i + 1) })}
                        </span>
                        <DocumentOpenButtons documentId={id} variant="icon" />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </StateBoundary>
    </section>
  );
}
