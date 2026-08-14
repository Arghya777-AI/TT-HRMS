/**
 * §9 · /admin/documents/pending — Approval Queue. What is outstanding on the
 * document side, in the two shapes the database actually holds it:
 *
 *   1. UPLOADS AWAITING VERIFICATION — `documents.status = 'pending_review'`,
 *      the manifest's own definition of this queue.
 *   2. OUTSTANDING ACKNOWLEDGEMENTS — `document_acknowledgements` rows that are
 *      neither `acknowledged` nor `waived`, with the overdue ones first.
 *
 * WHY THERE ARE NO DECIDE BUTTONS ON THIS SCREEN. Both actions are missing their
 * server side, and half-writing either one is worse than not offering it:
 *
 *  - Verifying an upload would mean PATCHing `documents.status` while leaving
 *    `reviewed_by` and `reviewed_at` empty. There is no `decide_document_review`
 *    RPC in `supabase/migrations/`, no `document-review` edge function, and no
 *    trigger that stamps the reviewer — so a row would say "approved" with
 *    nobody's name against it, which is exactly what an audit is for.
 *  - Waiving an acknowledgement is gated by `ck_da__waive_reason`
 *    (`waived_by` + `waived_at` + a ≥10-char reason) and the informed-consent
 *    guard `document_acknowledgements_ack_guard` owns the acknowledge path
 *    itself (≥90% scroll AND ≥8 seconds per page). Neither belongs in a browser.
 *
 * So this is a register: real filters, real server counts, and a notice naming
 * precisely what is missing. Every figure in the compliance table comes from
 * `v_policy_acknowledgement_status`, which counts and rounds in Postgres.
 *
 * @route /admin/documents/pending
 */
import { useMemo, useState } from "react";
import { Check, ClipboardCheck, FileClock, Inbox, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDateTime, fmtMmSs, nowIstDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { useMutation } from "@tanstack/react-query";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  ACK_ROW_CAP,
  QUEUE_ROW_CAP,
  useAckCount,
  useAcknowledgements,
  useDocumentCount,
  useDocumentList,
  usePolicyAckStatus,
} from "../hooks/useDocumentsAdmin";
import {
  decideDocumentReview,
  ackStatusValues,
  type AckFilters,
  type AckStatus,
  type AdminAck,
  type AdminDocument,
  type PolicyAckStatus,
} from "../api/documents.api";
import {
  ACK_STATUS_CHIP,
  DOCUMENT_STATUS_CHIP,
  VIRUS_CHIP,
  fmtFileSize,
} from "../documents/labels";

type Tab = "uploads" | "acks" | "compliance";

/** The three acknowledgement states that are still owed. */
const OPEN_ACK_STATUSES: readonly AckStatus[] = ["assigned", "opened", "overdue"];


/**
 * Approve / Reject for one waiting document, with the file one click away.
 *
 * VIEW COMES FIRST, deliberately: the whole failure mode of a review queue is
 * approving a filename. The reviewer can open the file before deciding, and every
 * open is written to `document_access_log` before the link exists.
 *
 * A REJECTION ASKS FOR A REASON and the server requires ten characters. That is the
 * one the employee has to act on — "rejected" with no reason means they re-upload the
 * same file and it is rejected again. An approval needs no sentence, because
 * demanding one only teaches people to type "ok".
 *
 * THE SERVER'S REFUSAL IS SHOWN VERBATIM. It knows things this component does not
 * (scope, whether the row is still pending) and its wording is the accurate one.
 */
function ReviewActions({ row, onDone }: { row: AdminDocument; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (v: { decision: "approved" | "rejected"; comment?: string }) =>
      decideDocumentReview(row.id, v.decision, v.comment),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <DocumentOpenButtons documentId={row.id} title={row.title} variant="icon" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ decision: "approved" })}
        >
          <Check className="mr-1.5 size-4" aria-hidden />
          {t("admin.docs.pend.approve")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={decide.isPending}
          onClick={() => {
            // A prompt, not a bare button: the server wants ten characters and this
            // sentence is what the employee will read and act on.
            const reason = window.prompt(t("admin.docs.pend.rejectPrompt"));
            if (reason !== null && reason.trim() !== "") {
              decide.mutate({ decision: "rejected", comment: reason.trim() });
            }
          }}
        >
          <X className="mr-1.5 size-4" aria-hidden />
          {t("admin.docs.pend.reject")}
        </Button>
      </div>
      {error !== null ? (
        <span className="max-w-[18rem] text-right text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}

export default function DocumentPendingPage() {
  const [tab, setTab] = useState<Tab>("uploads");
  const [ackStatus, setAckStatus] = useState<AckStatus | "">("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [neverOpenedOnly, setNeverOpenedOnly] = useState(false);

  const today = nowIstDate();
  const labels = useEmployeeLabels();

  // ── 1. Uploads awaiting verification ─────────────────────────────────────
  const uploadFilters = useMemo(() => ({ statuses: ["pending_review"] as const }), []);
  const uploads = useDocumentList(uploadFilters, "uploaded", QUEUE_ROW_CAP);
  const uploadCount = useDocumentCount(uploadFilters);

  // ── 2. Outstanding acknowledgements ──────────────────────────────────────
  const ackFilters = useMemo<AckFilters>(
    () => ({
      statuses: ackStatus === "" ? OPEN_ACK_STATUSES : [ackStatus],
      ...(overdueOnly ? { dueBefore: today } : {}),
      ...(neverOpenedOnly ? { neverOpenedOnly: true } : {}),
    }),
    [ackStatus, overdueOnly, neverOpenedOnly, today],
  );
  const overdueFilters = useMemo<AckFilters>(
    () => ({ statuses: OPEN_ACK_STATUSES, dueBefore: today }),
    [today],
  );
  const acks = useAcknowledgements(ackFilters);
  const ackCount = useAckCount(ackFilters);
  const overdueCount = useAckCount(overdueFilters);

  // ── 3. Per-document acknowledgement compliance ───────────────────────────
  const policy = usePolicyAckStatus();

  const personOf = (employeeId: string) => labels.data?.get(employeeId) ?? null;

  const uploadColumns: DataGridColumn<AdminDocument>[] = [
    {
      key: "title",
      header: t("admin.docs.pend.col.document"),
      width: "18rem",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.title}</span>
          <span className="text-xs text-muted-foreground">
            {dash(row.document_types?.name ?? null)}
          </span>
        </span>
      ),
    },
    {
      key: "employee_id",
      header: t("admin.docs.pend.col.subject"),
      width: "14rem",
      render: (row) => {
        if (row.employee_id === null) return dash(null);
        const who = personOf(row.employee_id);
        return <PersonCell name={who?.name ?? null} code={who?.code ?? null} secondary={who?.department ?? null} />;
      },
    },
    {
      key: "uploaded_at",
      header: t("admin.docs.pend.col.filed"),
      width: "12rem",
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{fmtDateTime(row.uploaded_at)}</span>,
    },
    {
      key: "expiry_date",
      header: t("admin.docs.pend.col.validTo"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) => (
        <span className="num">
          {row.expiry_date === null ? t("admin.docs.noExpiry") : fmtCivilDate(row.expiry_date)}
        </span>
      ),
    },
    {
      key: "file_size_bytes",
      header: t("admin.docs.pend.col.size"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{fmtFileSize(row.file_size_bytes)}</span>,
    },
    {
      key: "virus_scan_status",
      header: t("admin.docs.pend.col.scan"),
      width: "8rem",
      render: (row) => <StatusChip status={row.virus_scan_status} map={VIRUS_CHIP} />,
    },
    {
      key: "status",
      header: t("admin.docs.pend.col.status"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => <StatusChip status={row.status} map={DOCUMENT_STATUS_CHIP} />,
    },
    {
      /*
        THE DECIDE COLUMN. This screen shipped as a read-only register because both
        halves of a review were missing — there was no RPC, so approving would have
        written a status with no reviewer against it. Migration 087 supplies
        `decide_document_review`, which writes the status, the reviewer, the timestamp
        and the comment in one statement, and `document-access` supplies the link, so
        HR can look at the file before deciding rather than approving a filename.
      */
      key: "decide",
      header: "",
      align: "right",
      width: "20rem",
      render: (row) => <ReviewActions row={row} onDone={() => void uploads.refetch()} />,
    },
  ];

  const ackColumns: DataGridColumn<AdminAck>[] = [
    {
      key: "employee_id",
      header: t("admin.docs.pend.col.employee"),
      width: "15rem",
      render: (row) => {
        const who = personOf(row.employee_id);
        return <PersonCell name={who?.name ?? null} code={who?.code ?? null} secondary={who?.department ?? null} />;
      },
    },
    {
      key: "document_id",
      header: t("admin.docs.pend.col.document"),
      width: "16rem",
      render: (row) =>
        row.documents === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.docs.pend.docWithheld")}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="font-medium">{row.documents.title}</span>
            <span className="text-xs text-muted-foreground">
              {dash(row.documents.document_types?.name ?? null)}
            </span>
          </span>
        ),
    },
    {
      key: "status",
      header: t("admin.docs.pend.col.ackStatus"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={ACK_STATUS_CHIP} />,
    },
    {
      key: "due_on",
      header: t("admin.docs.pend.col.due"),
      width: "9rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.due_on ?? "",
      render: (row) =>
        row.due_on === null ? (
          <span className="text-muted-foreground">{t("admin.docs.pend.noDeadline")}</span>
        ) : (
          <span className={cn("num", row.due_on < today && "font-medium text-destructive")}>
            {fmtCivilDate(row.due_on)}
          </span>
        ),
    },
    {
      key: "assigned_at",
      header: t("admin.docs.pend.col.assigned"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{fmtDateTime(row.assigned_at)}</span>,
    },
    {
      key: "first_opened_at",
      header: t("admin.docs.pend.col.opened"),
      width: "12rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.first_opened_at === null ? (
          <span className="text-muted-foreground">{t("admin.docs.pend.neverOpened")}</span>
        ) : (
          <span className="num">{fmtDateTime(row.first_opened_at)}</span>
        ),
    },
    {
      key: "total_read_seconds",
      header: t("admin.docs.pend.col.read"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      // Both figures are server counters on the row (`total_read_seconds`,
      // `scroll_completion_pct`) — rendered, never re-derived. The dwell time is
      // formatted by the datetime library, which owns every seconds→clock render.
      render: (row) => (
        <span className="num">
          {formatPercent(row.scroll_completion_pct)}
          <span className="ml-1 text-xs text-muted-foreground">
            {fmtMmSs(row.total_read_seconds)}
          </span>
        </span>
      ),
    },
    {
      key: "reminder_count",
      header: t("admin.docs.pend.col.reminders"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.reminder_count)}</span>,
    },
  ];

  const policyColumns: DataGridColumn<PolicyAckStatus>[] = [
    {
      key: "document_title",
      header: t("admin.docs.pend.col.document"),
      width: "20rem",
      sortable: true,
      sortValue: (row) => row.document_title,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.document_title}</span>
          <span className="text-xs text-muted-foreground">{row.document_type_name}</span>
        </span>
      ),
    },
    {
      key: "assigned",
      header: t("admin.docs.pend.col.assignedN"),
      width: "8rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.assigned,
      render: (row) => <span className="num">{formatNumber(row.assigned)}</span>,
    },
    {
      key: "opened",
      header: t("admin.docs.pend.col.openedN"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatNumber(row.opened)}</span>,
    },
    {
      key: "acknowledged",
      header: t("admin.docs.pend.col.ackN"),
      width: "8rem",
      align: "right",
      render: (row) => <span className="num">{formatNumber(row.acknowledged)}</span>,
    },
    {
      key: "waived",
      header: t("admin.docs.pend.col.waivedN"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.waived)}</span>,
    },
    {
      key: "overdue",
      header: t("admin.docs.pend.col.overdueN"),
      width: "8rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.overdue,
      render: (row) => (
        <span className={cn("num", row.overdue > 0 && "font-medium text-destructive")}>
          {formatNumber(row.overdue)}
        </span>
      ),
    },
    {
      key: "acknowledged_pct",
      header: t("admin.docs.pend.col.ackPct"),
      width: "9rem",
      align: "right",
      // ROUND(... * 100.0 / NULLIF(...)) — computed by the view (§9.3).
      render: (row) => <span className="num">{formatPercent(row.acknowledged_pct)}</span>,
    },
    {
      key: "earliest_open_due_on",
      header: t("admin.docs.pend.col.nextDue"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      render: (row) => (
        <span className="num">
          {row.earliest_open_due_on === null
            ? t("admin.docs.pend.noDeadline")
            : fmtCivilDate(row.earliest_open_due_on)}
        </span>
      ),
    },
  ];

  const TABS: readonly { id: Tab; label: string; count: number | undefined; error: unknown }[] = [
    {
      id: "uploads",
      label: t("admin.docs.pend.tab.uploads"),
      count: uploadCount.data,
      error: uploadCount.error,
    },
    {
      id: "acks",
      label: t("admin.docs.pend.tab.acks"),
      count: ackCount.data,
      error: ackCount.error,
    },
    {
      id: "compliance",
      label: t("admin.docs.pend.tab.compliance"),
      count: undefined,
      error: policy.error,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Inbox}
        title={t("admin.docs.pend.title")}
        subtitle={
          uploadCount.isSuccess && overdueCount.isSuccess
            ? t("admin.docs.pend.subtitle", {
                uploads: formatNumber(uploadCount.data),
                overdue: formatNumber(overdueCount.data),
              })
            : t("admin.docs.pend.subtitlePlain")
        }
      />

      <div className="mt-4">
        <Notice tone="note">{t("admin.docs.pend.noDecide")}</Notice>
      </div>

      <div
        className="mt-4 flex flex-wrap gap-2"
        role="tablist"
        aria-label={t("admin.docs.pend.title")}
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "rounded-md border px-3 py-2 text-sm transition-colors",
              tab === entry.id
                ? "border-primary bg-primary/5 font-medium"
                : "hover:border-primary/40",
            )}
          >
            {entry.label}
            {entry.count !== undefined ? (
              <span className="num ml-2 text-muted-foreground">{formatNumber(entry.count)}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "uploads" ? (
        <div className="mt-4">
          <StateBoundary
            loading={uploads.isPending}
            error={uploads.error}
            onRetry={() => void uploads.refetch()}
            isEmpty={(uploads.data ?? []).length === 0}
            partialError={uploadCount.error ?? labels.error}
            partialLabel={t("admin.docs.pend.partial")}
            empty={
              <EmptyState
                icon={FileClock}
                title={t("admin.docs.pend.uploads.empty.title")}
                hint={t("admin.docs.pend.uploads.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={uploadColumns}
              rows={uploads.data ?? []}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </div>
      ) : null}

      {tab === "acks" ? (
        <>
          <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
            <SelectField
              label={t("admin.docs.pend.filter.ackStatus")}
              value={ackStatus}
              placeholder={t("admin.docs.pend.filter.anyOpen")}
              options={ackStatusValues.map((value) => ({
                value,
                label: ACK_STATUS_CHIP[value].label,
              }))}
              onChange={(v) => setAckStatus(v as AckStatus | "")}
              hint={t("admin.docs.pend.filter.ackStatusHint")}
            />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
              <Button
                type="button"
                variant={overdueOnly ? "default" : "outline"}
                onClick={() => setOverdueOnly((v) => !v)}
                aria-pressed={overdueOnly}
              >
                {t("admin.docs.pend.filter.overdue")}
              </Button>
              <Button
                type="button"
                variant={neverOpenedOnly ? "default" : "outline"}
                onClick={() => setNeverOpenedOnly((v) => !v)}
                aria-pressed={neverOpenedOnly}
              >
                {t("admin.docs.pend.filter.neverOpened")}
              </Button>
              {ackStatus !== "" || overdueOnly || neverOpenedOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setAckStatus("");
                    setOverdueOnly(false);
                    setNeverOpenedOnly(false);
                  }}
                >
                  {t("admin.docs.exp.filter.clear")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <StateBoundary
              loading={acks.isPending}
              error={acks.error}
              onRetry={() => void acks.refetch()}
              isEmpty={(acks.data ?? []).length === 0}
              partialError={ackCount.error ?? labels.error}
              partialLabel={t("admin.docs.pend.partial")}
              empty={
                <EmptyState
                  icon={ClipboardCheck}
                  title={t("admin.docs.pend.acks.empty.title")}
                  hint={t("admin.docs.pend.acks.empty.hint")}
                />
              }
            >
              <DataGrid
                columns={ackColumns}
                rows={acks.data ?? []}
                rowKey={(row) => row.id}
                pageSize={25}
              />
            </StateBoundary>
          </div>

          {ackCount.isSuccess && ackCount.data > (acks.data ?? []).length ? (
            <div className="mt-4">
              <Notice tone="warning">
                {t("admin.docs.pend.capped", {
                  shown: formatNumber((acks.data ?? []).length),
                  total: formatNumber(ackCount.data),
                  cap: formatNumber(ACK_ROW_CAP),
                })}
              </Notice>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "compliance" ? (
        <div className="mt-4">
          <StateBoundary
            loading={policy.isPending}
            error={policy.error}
            onRetry={() => void policy.refetch()}
            isEmpty={(policy.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={ClipboardCheck}
                title={t("admin.docs.pend.policy.empty.title")}
                hint={t("admin.docs.pend.policy.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={policyColumns}
              rows={policy.data ?? []}
              rowKey={(row) => row.document_id}
              pageSize={25}
            />
          </StateBoundary>
        </div>
      ) : null}

      <div className="mt-4">
        <Notice tone="info">{t("admin.docs.pend.footnote")}</Notice>
      </div>
    </div>
  );
}
