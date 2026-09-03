/**
 * ClaimEvidenceSheet — the bill behind a claim, and everyone who has looked at it.
 *
 * ── WHAT WAS WRONG, AND IT WAS NOT A PERMISSION ──────────────────────────────
 * `/admin/payroll/reimbursements` offered a Decide button on money and showed no evidence
 * whatsoever. Not because an admin was refused: `documents__admin__all`, the
 * `documents__admin_all` storage policy and `document-access` all admit them, verified by
 * impersonating each live administrator under RLS. The receipt was simply never fetched,
 * because it does not live on `reimbursement_claims` — it lives on
 * `claim_lines.receipt_document_id`, one level down, and the page read only the header.
 *
 * So an approver was being asked to take a number on trust. This sheet is the evidence.
 *
 * ── EVERY FIELD IS A STORED COLUMN ───────────────────────────────────────────
 * Nothing here is derived, inferred or reconstructed. `distance_km` and `rate_per_km_paise`
 * are printed SIDE BY SIDE with the claimed amount rather than multiplied into a check,
 * because the arithmetic is the approver's to do — a computed "expected" figure would invite
 * them to trust this screen's multiplication instead of the bill.
 *
 * ── THREE DIFFERENT ABSENCES, NEVER COLLAPSED ────────────────────────────────
 * A line with no receipt, a line that OWES one, and a line whose receipt this reader may not
 * open are three different facts. Rendering the third as "none attached" would tell an
 * approver the employee filed nothing, which is the most damaging sentence on the screen.
 */
import { useMemo } from "react";
import { FileWarning, Paperclip, ShieldAlert } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Money } from "@/shared/ui/Money";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import type { AccessKind } from "../api/documents.api";
import type { ActorProfile } from "../api/audit-registers.api";
import type {
  ClaimApprovalAction,
  ClaimLineWithReceipt,
  ClaimReceipt,
  ReceiptAccess,
} from "../api/claimEvidence.api";
import type { ReimbursementClaim } from "../api/payroll-statutory.api";
import { useClaimAuditTrail } from "../hooks/useClaimEvidence";

export interface ClaimEvidenceSheetProps {
  readonly claim: ReimbursementClaim | null;
  readonly lines: readonly ClaimLineWithReceipt[];
  readonly employeeName: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

/** One label/value pair. Absent values print an em dash rather than vanishing. */
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
      {hint !== undefined ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function actorName(id: string | null, actors: ReadonlyMap<string, ActorProfile>): string {
  if (id === null) return t("admin.reimb.ev.unknownActor");
  return actors.get(id)?.full_name ?? t("admin.reimb.ev.unknownActor");
}

/**
 * `document_access_log.access_kind` → a sentence.
 *
 * AN EXHAUSTIVE `Record<AccessKind, …>` ON PURPOSE, not a template string.
 *
 * The first version built the key as `` `admin.reimb.ev.kind.${kind}` `` and fell back to the
 * raw value when the lookup "returned the key". That fallback could never fire: `t()` is
 * `en[key]` with no default, so a missing key yields `undefined` — the cell would have
 * rendered EMPTY, and `t(key, vars)` would have thrown on `undefined.replace`. Typing the map
 * on `AccessKind` makes a new constraint value a compile error instead.
 *
 * The schema still reads `access_kind` as a plain string, so a value added to
 * `ck_dal__access_kind` ahead of this code prints raw rather than blank.
 */
const ACCESS_KIND_LABELS: Record<AccessKind, MessageKey> = {
  view: "admin.reimb.ev.kind.view",
  download: "admin.reimb.ev.kind.download",
  print: "admin.reimb.ev.kind.print",
  signed_url_minted: "admin.reimb.ev.kind.signed_url_minted",
  email_attachment: "admin.reimb.ev.kind.email_attachment",
  api: "admin.reimb.ev.kind.api",
};

function accessKindLabel(kind: string): string {
  const key = (ACCESS_KIND_LABELS as Record<string, MessageKey | undefined>)[kind];
  return key === undefined ? kind : t(key);
}

function scanBadge(receipt: ClaimReceipt): { label: string; hint?: string; tone: string } {
  if (receipt.virus_scan_status === "clean") {
    return { label: t("admin.reimb.ev.b.scan.clean"), tone: "text-foreground" };
  }
  if (receipt.virus_scan_status === "infected") {
    return { label: t("admin.reimb.ev.b.scan.infected"), tone: "text-destructive" };
  }
  return {
    label: t("admin.reimb.ev.b.scan.pending"),
    hint: t("admin.reimb.ev.b.scan.pendingHint"),
    tone: "text-amber-700 dark:text-amber-400",
  };
}

/** Bytes as the smallest honest unit. Never a rounded "0 MB" for a 40 kB bill. */
function fileSize(bytes: number | null): string {
  if (bytes === null) return dash(null);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} kB`;
  return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

function ReceiptBlock({ row }: { row: ClaimLineWithReceipt }) {
  const { line, receipt } = row;

  if (receipt === null) {
    // THE THREE ABSENCES. An unreadable receipt is not a missing one.
    if (line.receipt_document_id !== null) {
      return (
        <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          {t("admin.reimb.ev.billUnreadable")}
        </p>
      );
    }
    return (
      <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs">
        <FileWarning className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        {line.is_receipt_required
          ? t("admin.reimb.ev.noBillRequired")
          : t("admin.reimb.ev.noBill")}
      </p>
    );
  }

  const scan = scanBadge(receipt);
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium">
          {dash(receipt.file_name ?? receipt.title)}
        </p>
        <DocumentOpenButtons documentId={receipt.id} title={receipt.file_name ?? receipt.title} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label={t("admin.reimb.ev.b.type")}>{dash(receipt.mime_type)}</Field>
        <Field label={t("admin.reimb.ev.b.size")}>{fileSize(receipt.file_size_bytes)}</Field>
        <Field label={t("admin.reimb.ev.b.scan")} hint={scan.hint}>
          <span className={scan.tone}>{scan.label}</span>
        </Field>
        <Field label={t("admin.reimb.ev.b.billDate")}>{fmtCivilDate(receipt.issue_date)}</Field>
        <Field label={t("admin.reimb.ev.b.uploaded")}>{fmtDateTime(receipt.created_at)}</Field>
        <Field label={t("admin.reimb.ev.b.status")}>{receipt.status}</Field>
        <div className="col-span-2 sm:col-span-3">
          <Field label={t("admin.reimb.ev.b.checksum")} hint={t("admin.reimb.ev.b.checksumHint")}>
            <span className="break-all font-mono text-xs">{dash(receipt.checksum_sha256)}</span>
          </Field>
        </div>
      </dl>
    </div>
  );
}

function LineBlock({ row, index }: { row: ClaimLineWithReceipt; index: number }) {
  const { line } = row;
  const hasRoute = line.from_location !== null || line.to_location !== null;
  return (
    <li className="rounded-lg border p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t("admin.reimb.ev.lineN", { n: String(index + 1) })}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label={t("admin.reimb.ev.f.date")}>{fmtCivilDate(line.line_date)}</Field>
        <Field label={t("admin.reimb.ev.f.head")}>{dash(line.expense_head)}</Field>
        <Field label={t("admin.reimb.ev.f.claimed")}>
          <Money paise={line.amount_claimed_paise} />
        </Field>
        <Field label={t("admin.reimb.ev.f.approved")}>
          <Money paise={line.amount_approved_paise} />
        </Field>
        <Field label={t("admin.reimb.ev.f.tax")}>
          <Money paise={line.tax_amount_paise} />
        </Field>
        <Field label={t("admin.reimb.ev.f.gst")}>{dash(line.gst_number)}</Field>

        {hasRoute ? (
          <>
            <Field label={t("admin.reimb.ev.f.from")} hint={t("admin.reimb.ev.routeHint")}>
              {dash(line.from_location)}
            </Field>
            <Field label={t("admin.reimb.ev.f.to")}>{dash(line.to_location)}</Field>
          </>
        ) : null}
        {/*
          Distance and rate are printed, never multiplied into an "expected" total. The
          approver's job is to check the arithmetic against the bill; a computed figure here
          would invite them to trust this screen's sum instead.
        */}
        {line.distance_km !== null ? (
          <Field label={t("admin.reimb.ev.f.distance")}>
            {t("admin.reimb.ev.km", { km: formatNumber(line.distance_km) })}
          </Field>
        ) : null}
        {line.rate_per_km_paise !== null ? (
          <Field label={t("admin.reimb.ev.f.rate")}>
            <Money paise={line.rate_per_km_paise} />
          </Field>
        ) : null}
        {line.travel_mode !== null ? (
          <Field label={t("admin.reimb.ev.f.mode")}>{line.travel_mode}</Field>
        ) : null}
        {line.travel_purpose !== null ? (
          <Field label={t("admin.reimb.ev.f.purpose")}>{line.travel_purpose}</Field>
        ) : null}
        <div className="col-span-2 sm:col-span-3">
          <Field label={t("admin.reimb.ev.f.desc")}>{dash(line.description)}</Field>
        </div>
        {line.rejection_reason !== null ? (
          <div className="col-span-2 sm:col-span-3">
            <Field label={t("admin.reimb.ev.f.rejected")}>
              <span className="text-destructive">{line.rejection_reason}</span>
            </Field>
          </div>
        ) : null}
        <div className="col-span-2 sm:col-span-3">
          <Field label={t("admin.reimb.ev.f.filed")}>{fmtDateTime(line.created_at)}</Field>
        </div>
      </dl>
      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          {t("admin.reimb.ev.billTitle")}
        </p>
        <ReceiptBlock row={row} />
      </div>
    </li>
  );
}

function ApprovalRow({
  action,
  actors,
  totalLevels,
}: {
  action: ClaimApprovalAction;
  actors: ReadonlyMap<string, ActorProfile>;
  totalLevels: number | null;
}) {
  return (
    <li className="border-l-2 py-1.5 pl-3 text-sm">
      <p>
        <span className="font-medium">{action.action}</span>
        {" — "}
        {actorName(action.actor_id, actors)}
        {action.actor_role !== null ? (
          <span className="text-muted-foreground">
            {" "}
            {t("admin.reimb.ev.byRole", { role: action.actor_role })}
          </span>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {totalLevels !== null
          ? t("admin.reimb.ev.level", { n: String(action.level), total: String(totalLevels) })
          : t("admin.reimb.ev.levelShort", { n: String(action.level) })}
        {" · "}
        {fmtDateTime(action.acted_at)}
        {action.ip !== null ? ` · ${t("admin.reimb.ev.fromIp", { ip: action.ip })}` : ""}
      </p>
      {action.comment !== null && action.comment !== "" ? (
        <p className="mt-0.5 break-words text-xs">{action.comment}</p>
      ) : null}
    </li>
  );
}

function AccessRow({
  row,
  actors,
}: {
  row: ReceiptAccess;
  actors: ReadonlyMap<string, ActorProfile>;
}) {
  return (
    <li className="border-l-2 py-1.5 pl-3 text-sm">
      <p>
        <span className="font-medium">{accessKindLabel(row.access_kind)}</span>
        {" — "}
        {actorName(row.accessed_by, actors)}
        {row.accessed_by_role !== null ? (
          <span className="text-muted-foreground">
            {" "}
            {t("admin.reimb.ev.byRole", { role: row.accessed_by_role })}
          </span>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {fmtDateTime(row.recorded_at)}
        {row.ip !== null ? ` · ${t("admin.reimb.ev.fromIp", { ip: row.ip })}` : ""}
        {row.on_behalf_of !== null
          ? ` · ${t("admin.reimb.ev.onBehalf", { name: actorName(row.on_behalf_of, actors) })}`
          : ""}
      </p>
    </li>
  );
}

export function ClaimEvidenceSheet({
  claim,
  lines,
  employeeName,
  onOpenChange,
}: ClaimEvidenceSheetProps) {
  const trail = useClaimAuditTrail(claim?.id ?? null, claim?.approval_request_id ?? null, lines);
  const actors = useMemo(() => trail.data?.actors ?? new Map<string, ActorProfile>(), [trail.data]);
  const actions = trail.data?.actions ?? [];
  const access = trail.data?.access ?? [];

  return (
    <Sheet open={claim !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-display">
            {t("admin.reimb.ev.title", { claim: claim?.claim_number ?? "" })}
          </SheetTitle>
          <SheetDescription>
            {employeeName !== null ? `${employeeName} · ` : ""}
            {t("admin.reimb.ev.subtitle")}
          </SheetDescription>
        </SheetHeader>

        {claim === null ? null : (
          <div className="mt-4 space-y-6">
            {/* ── The lines and their bills ──────────────────────────────── */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t("admin.reimb.ev.linesTitle")}</h3>
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("admin.reimb.ev.noLines")}</p>
              ) : (
                <ul className="space-y-3">
                  {lines.map((row, i) => (
                    <LineBlock key={row.line.id} row={row} index={i} />
                  ))}
                </ul>
              )}
            </section>

            {/* ── The trail ──────────────────────────────────────────────── */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">{t("admin.reimb.ev.trailTitle")}</h3>

              <div className="mb-3 rounded-md bg-muted/50 p-2 text-xs">
                <p>{t("admin.reimb.ev.filedAt", { when: fmtDateTime(claim.created_at) })}</p>
                {claim.decided_at !== null ? (
                  <p>{t("admin.reimb.ev.decidedAt", { when: fmtDateTime(claim.decided_at) })}</p>
                ) : null}
                {claim.decided_comment !== null && claim.decided_comment !== "" ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">
                      {t("admin.reimb.ev.decidedComment")}:{" "}
                    </span>
                    {claim.decided_comment}
                  </p>
                ) : null}
              </div>

              {/*
                `StateBoundary` takes loading/error/children — there is no render-prop form.
                The trail is a SECONDARY read: the lines and the bills above have already
                rendered from the register's own query, so a failure here must not blank the
                sheet. Hence `partialError`, which keeps the content and puts an honest banner
                over it, rather than `error`, which would replace the evidence with a retry.
              */}
              <StateBoundary
                loading={trail.isPending}
                partialError={trail.error}
                partialLabel={t("admin.reimb.ev.trailTitle")}
                onRetry={() => void trail.refetch()}
              >
                <div className="space-y-4">
                  <div>
                    <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                      {t("admin.reimb.ev.approvalsTitle")}
                    </h4>
                    {claim.approval_request_id === null ? (
                      <p className="text-sm text-muted-foreground">
                        {t("admin.reimb.ev.noChain")}
                      </p>
                    ) : actions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("admin.reimb.ev.noApprovals")}
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {actions.map((a) => (
                          <ApprovalRow key={a.id} action={a} actors={actors} totalLevels={null} />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                      {t("admin.reimb.ev.readsTitle")}
                    </h4>
                    <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
                      {t("admin.reimb.ev.readsHint")}
                    </p>
                    {access.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("admin.reimb.ev.noReads")}</p>
                    ) : (
                      <ul className="space-y-1">
                        {access.map((row) => (
                          <AccessRow key={row.id} row={row} actors={actors} />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </StateBoundary>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The register's Bills cell. Exported so the column stays a one-liner. */
export function AttachmentCount({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
      {n}
    </span>
  );
}
