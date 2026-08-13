/**
 * E-14 · /me/helpdesk — Help Desk.
 *
 * ── THIS PAGE USED TO BE AN HONEST GAP, AND IS NOT ANY MORE ──────────────────
 *
 * For its whole life this screen rendered a notice saying the backing table did
 * not exist, and it was telling the truth. Probed on the live project as an
 * employee:
 *
 *     GET /rest/v1/helpdesk_tickets  →  404 PGRST205
 *       "Could not find the table 'public.helpdesk_tickets' in the schema cache"
 *
 * `grep -rn helpdesk supabase/migrations/` returned nothing: no ticket table, no
 * SLA table, no ticket-comment table, and so nothing to read and nowhere to
 * write. Rendering approval rows here under a "your tickets" heading would have
 * been the mislabelling DR-08/DR-09 exist to prevent, so the page rendered
 * neither.
 *
 * Migration 041500 created `helpdesk_tickets` and `helpdesk_messages` with both
 * service-level clocks; migration 041000 created `document_requests`. Those are
 * the two things this page now does, and they are different objects on purpose:
 *
 *   · a DOCUMENT REQUEST is routed through the approval engine — HR either
 *     issues the paper or does not,
 *   · a TICKET has an assignee and a conversation, and can be reopened.
 *
 * ── A TICKET IS NOT THE THING /me/helpdesk/:id OPENS ─────────────────────────
 *
 * That sibling route renders an APPROVAL REQUEST thread and says so in its own
 * banner. Rows in the list below are `helpdesk_tickets` and expand in place
 * rather than navigating, so the two never collide — and they take different
 * query keys for the same reason (see the comment on `qk.helpdesk`).
 *
 * ── WHAT IS STILL NOT HERE ───────────────────────────────────────────────────
 *
 * There is no desk-membership table, so administrators are the desk: the
 * assignee picker, the internal-note composer and the desk-side queue belong on
 * an admin screen and are not faked here. Attachments are not offered —
 * `documents` has no ticket linkage — and nothing on this page pretends
 * otherwise.
 *
 * @route /me/helpdesk
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, FileText, LifeBuoy, MessageSquare, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Required } from "@/shared/ui/Required";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/features/admin/components/Notice";
import { mutationUserMessage } from "@/shared/api/query";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { SubmitAttemptScope, SubmitBlockers, blockerButtonProps, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { fmtDateTime, nowIstDate } from "@/lib/datetime";
import { type MessageKey, t } from "@/shared/i18n/en";
import { documentKindValues, type DocumentKind } from "@/features/apply/api/simple-requests.api";
import {
  useMyOpenRequestsOfType,
  useRequestTypeByCode,
  useSubmitDocumentRequest,
} from "@/features/apply/hooks/useApply";
import { OpenRequestsGrid } from "@/features/apply/components/OpenRequestsGrid";
import {
  REQUEST_CODE_DOCUMENT,
  REQUEST_CODE_PAYSLIP,
} from "@/features/apply/api/simple-requests.api";
import {
  canReply,
  helpdeskDeskValues,
  helpdeskPriorityValues,
  isBreached,
  type HelpdeskDesk,
  type HelpdeskPriority,
  type HelpdeskTicket,
} from "../api/helpdesk.api";
import {
  useMyTickets,
  usePostTicketMessage,
  useRaiseTicket,
  useSetTicketStatus,
  useTicketMessages,
} from "../hooks/useHelpdesk";

/** Kinds that cover a stretch of time rather than a fact about today. */
const PERIODIC_KINDS: readonly DocumentKind[] = ["payslip", "salary_certificate", "form16"];

/** `ck_hdt__status`, each with the tone that says what it means at a glance. */
const TICKET_STATUS_MAP: Record<string, StatusChipEntry> = {
  open: { label: t("helpdesk.ticket.status.open"), tone: "info" },
  in_progress: { label: t("helpdesk.ticket.status.in_progress"), tone: "info" },
  waiting_on_requester: { label: t("helpdesk.ticket.status.waiting"), tone: "warn" },
  resolved: { label: t("helpdesk.ticket.status.resolved"), tone: "success" },
  closed: { label: t("helpdesk.ticket.status.closed"), tone: "neutral" },
  cancelled: { label: t("helpdesk.ticket.status.cancelled"), tone: "neutral" },
};

/** The conversation on one ticket, plus the box to add to it. */
function TicketDetail({ ticket }: { ticket: HelpdeskTicket }) {
  const messages = useTicketMessages(ticket.id);
  const post = usePostTicketMessage();
  const setStatus = useSetTicketStatus();
  const [body, setBody] = useState("");

  const replyAllowed = canReply(ticket.status);

  return (
    <div className="space-y-3 px-1 py-2">
      <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>

      {ticket.resolution_note !== null ? (
        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium">{t("helpdesk.ticket.resolution")}</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{ticket.resolution_note}</p>
        </div>
      ) : null}

      <section aria-label={t("helpdesk.ticket.conversation")}>
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
          {t("helpdesk.ticket.conversation")}
        </h3>
        <StateBoundary
          loading={messages.isLoading}
          error={messages.error ?? undefined}
          onRetry={() => void messages.refetch()}
          isEmpty={messages.data !== undefined && messages.data.length === 0}
          empty={<p className="mt-1 text-sm text-muted-foreground">{t("helpdesk.ticket.noReplies")}</p>}
          skeletonRows={1}
        >
          <ul className="mt-2 space-y-2">
            {(messages.data ?? []).map((m) => (
              <li key={m.id} className="rounded-md border bg-card p-2.5 text-sm">
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</p>
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>

      {replyAllowed ? (
        <div>
          <Label htmlFor={`hd-reply-${ticket.id}`}>{t("helpdesk.ticket.reply")}</Label>
          <textarea
            id={`hd-reply-${ticket.id}`}
            rows={2}
            maxLength={5000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {post.isError ? (
            <div className="mt-2"><Notice tone="error">{mutationUserMessage(post.error)}</Notice></div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={body.trim() === "" || post.isPending}
              onClick={() => {
                if (body.trim() === "") return;
                post.mutate(
                  { ticketId: ticket.id, body },
                  { onSuccess: () => { setBody(""); } },
                );
              }}
            >
              {post.isPending ? t("helpdesk.ticket.sending") : t("helpdesk.ticket.send")}
            </Button>

            {/*
              The two transitions trg_hdt__guard allows a requester. Reopening is
              offered only on a resolved ticket, cancelling only while it is
              still being worked — anything else raises 23514 server-side, and a
              button that exists to be refused is a button that should not exist.
            */}
            {ticket.status === "resolved" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ ticketId: ticket.id, status: "open" })}
              >
                {t("helpdesk.ticket.reopen")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ ticketId: ticket.id, status: "cancelled" })}
              >
                {t("helpdesk.ticket.cancel")}
              </Button>
            )}
          </div>
          {setStatus.isError ? (
            <div className="mt-2"><Notice tone="error">{mutationUserMessage(setStatus.error)}</Notice></div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("helpdesk.ticket.locked")}</p>
      )}
    </div>
  );
}

export default function HelpdeskPage() {
  const today = nowIstDate();

  // ── Document request (document_requests, migration 041000) ─────────────────
  const [kind, setKind] = useState<DocumentKind>("payslip");
  const [addressedTo, setAddressedTo] = useState("");
  const [note, setNote] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [docSent, setDocSent] = useState<string | null>(null);
  const sendDoc = useSubmitDocumentRequest();
  /*
    Their own document requests — BOTH types, which is the whole subtlety.

    `submitDocumentRequest` files a payslip under `PAYSLIP_REQUEST` and every
    other kind under `DOCUMENT_REQUEST` (simple-requests.api.ts:404), because the
    two have different approval chains. Asking for one type listed exactly half of
    what somebody had asked for, and the half it dropped was payslips — the most
    commonly requested document of the lot. Reported as: "previously employee
    requested for payslip that request is visible at approval but not at
    helpdesk".

    Read by CODE rather than a hard-coded id: the ids differ per deployment.
  */
  const docType = useRequestTypeByCode(REQUEST_CODE_DOCUMENT);
  const payslipType = useRequestTypeByCode(REQUEST_CODE_PAYSLIP);
  const docOnly = useMyOpenRequestsOfType(docType.data?.id);
  const payslipOnly = useMyOpenRequestsOfType(payslipType.data?.id);

  /* One list, newest first — the two chains are an internal detail, not
     something an employee should have to know to find their own request. */
  const myDocRequests = useMemo(() => {
    const rows = [...(docOnly.data?.rows ?? []), ...(payslipOnly.data?.rows ?? [])].sort((a, b) =>
      a.submitted_at < b.submitted_at ? 1 : a.submitted_at > b.submitted_at ? -1 : 0,
    );
    return {
      rows,
      approvers: { ...(docOnly.data?.approvers ?? {}), ...(payslipOnly.data?.approvers ?? {}) },
    };
  }, [docOnly.data, payslipOnly.data]);

  const docRequestsPending = docOnly.isLoading || payslipOnly.isLoading;
  const docRequestsError = docOnly.error ?? payslipOnly.error ?? undefined;
  const docAttempt = useSubmitAttempt();

  const periodic = PERIODIC_KINDS.includes(kind);

  const docBlockers: string[] = [];
  if (note.trim().length < 10) docBlockers.push(t("helpdesk.doc.blocked.note"));
  /*
    BOTH ENDS, for a payslip. Only `periodFrom` was checked, so "from 01-Apr" with
    no end date passed the form and reached the database as an open-ended period
    — which is not a payslip request anybody can fulfil. Asked for: "star mark
    period from and to because it should be compulsory if it is asked for
    payslip".
  */
  if (kind === "payslip" && periodFrom === "") docBlockers.push(t("helpdesk.doc.blocked.periodFrom"));
  if (kind === "payslip" && periodTo === "") docBlockers.push(t("helpdesk.doc.blocked.periodTo"));
  if (periodFrom !== "" && periodFrom > today) docBlockers.push(t("helpdesk.doc.blocked.future"));
  if (periodTo !== "" && periodTo > today) docBlockers.push(t("helpdesk.doc.blocked.future"));
  if (periodFrom !== "" && periodTo !== "" && periodTo < periodFrom) {
    docBlockers.push(t("helpdesk.doc.blocked.order"));
  }

  // ── Tickets (helpdesk_tickets, migration 041500) ───────────────────────────
  const tickets = useMyTickets();
  const raise = useRaiseTicket();
  const ticketAttempt = useSubmitAttempt();
  const [desk, setDesk] = useState<HelpdeskDesk>("hr");
  const [priority, setPriority] = useState<HelpdeskPriority>("normal");
  const [subject, setSubject] = useState("");
  const [detail, setDetail] = useState("");
  const [ticketSent, setTicketSent] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const ticketBlockers: string[] = [];
  if (subject.trim().length < 5) ticketBlockers.push(t("helpdesk.new.blocked.subject"));
  if (detail.trim().length < 10) ticketBlockers.push(t("helpdesk.new.blocked.detail"));

  /*
    One clock reading for the whole render. Calling Date.now() inside the column
    renderer would give two rows in the same table different "now"s, which is how
    a list ends up showing a ticket as breached in one column and not the other.
  */
  const nowMs = Date.now();

  const ticketColumns: DataGridColumn<HelpdeskTicket>[] = [
    {
      key: "ticket_number",
      header: t("helpdesk.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.ticket_number}</span>,
    },
    {
      key: "subject",
      header: t("helpdesk.col.subject"),
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{row.subject}</span>
          {isBreached(row.first_response_due_at, row.first_responded_at, nowMs) ? (
            <Badge variant="warning">{t("helpdesk.col.lateReply")}</Badge>
          ) : null}
          {isBreached(row.resolution_due_at, row.resolved_at, nowMs) ? (
            <Badge variant="destructive">{t("helpdesk.col.lateFix")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "desk",
      header: t("helpdesk.col.desk"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => t(`helpdesk.desk.${row.desk}` as MessageKey),
    },
    {
      key: "status",
      header: t("helpdesk.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={TICKET_STATUS_MAP} />,
    },
    {
      /*
        WHO HAS IT — the question every requester actually has, and the one this
        list did not answer. It showed a status chip and left "is anybody looking
        at this" to be inferred from it.

        NOT A NAME. `assigned_to` is a `profiles.id`, and an employee may read
        only their OWN profile row (`profiles__self_read`) — so the name is not
        theirs to see, and embedding it would render an empty column that looks
        like a fault. What IS visible and true is whether the desk has picked it
        up, which is the half that changes what the requester does next.
      */
      key: "assigned_to",
      header: t("helpdesk.col.with"),
      width: "12rem",
      render: (row) =>
        row.assigned_to === null ? (
          <Badge variant="warning">{t("helpdesk.with.unclaimed")}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">{t("helpdesk.with.claimed")}</span>
        ),
    },
    {
      key: "created_at",
      header: t("helpdesk.col.raised"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.created_at),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={t("helpdesk.title")}
        subtitle={t("helpdesk.subtitle")}
      />

      {/* ── Raise a ticket ───────────────────────────────────────────────── */}
      {ticketSent !== null ? (
        <div className="mt-4"><Notice tone="success">{t("helpdesk.new.done", { ref: ticketSent })}</Notice></div>
      ) : null}

      <SubmitAttemptScope attempt={ticketAttempt}>
      <section className="mt-4 rounded-lg border bg-card p-4" aria-labelledby="hd-new">
        <h2 id="hd-new" className="flex items-center gap-2 font-display text-lg font-semibold">
          <LifeBuoy className="size-4 text-muted-foreground" aria-hidden />
          {t("helpdesk.new.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.new.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="hd-desk">{t("helpdesk.new.desk")}</Label>
            <select
              id="hd-desk"
              value={desk}
              onChange={(e) => setDesk(e.target.value as HelpdeskDesk)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {helpdeskDeskValues.map((d) => (
                <option key={d} value={d}>{t(`helpdesk.desk.${d}` as MessageKey)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="hd-priority">{t("helpdesk.new.priority")}</Label>
            <select
              id="hd-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as HelpdeskPriority)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {helpdeskPriorityValues.map((p) => (
                <option key={p} value={p}>{t(`helpdesk.priority.${p}` as MessageKey)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <Label htmlFor="hd-subject">{t("helpdesk.new.subject")}<Required /></Label>
          <Input
        required
            id="hd-subject"
            className="mt-1.5 h-11"
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div className="mt-3">
          <Label htmlFor="hd-detail">{t("helpdesk.new.detail")}<Required /></Label>
          <textarea
        required
            id="hd-detail"
            rows={3}
            maxLength={5000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
        </div>

        {raise.isError ? (
          <div className="mt-3"><Notice tone="error">{mutationUserMessage(raise.error)}</Notice></div>
        ) : null}

        <SubmitBlockers
          attempt={ticketAttempt}
          blockers={ticketBlockers}
          id="hd-ticket-blockers"
          title={t("helpdesk.new.blocked.title")}
        />

        <Button
          className="mt-4 w-full"
          disabled={raise.isPending}
          {...blockerButtonProps(ticketAttempt, ticketBlockers, "hd-ticket-blockers")}
          onClick={() => {
            if (!ticketAttempt.press(ticketBlockers)) return;
            raise.mutate(
              { desk, priority, subject, description: detail },
              {
                onSuccess: (row) => {
                  ticketAttempt.reset();
                  setTicketSent(row.ticket_number);
                  setSubject("");
                  setDetail("");
                  /* The reference the desk and the requester will both quote.
                     Minted by trg_hdt__number, never by this browser. */
                  confirmSubmitted(t("helpdesk.new.title"), {
                    reference: row.ticket_number,
                    detail: t("helpdesk.new.toast.next"),
                  });
                },
              },
            );
          }}
        >
          {raise.isPending ? t("helpdesk.new.sending") : t("helpdesk.new.send")}
        </Button>
      </section>

      </SubmitAttemptScope>

      {/* ── My tickets ───────────────────────────────────────────────────── */}
      <section className="mt-6" aria-labelledby="hd-mine">
        <h2 id="hd-mine" className="font-display text-lg font-semibold">
          {t("helpdesk.mine.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("helpdesk.mine.hint")}</p>
        <StateBoundary
          loading={tickets.isLoading}
          error={tickets.error ?? undefined}
          onRetry={() => void tickets.refetch()}
        >
          <DataGrid
            columns={ticketColumns}
            rows={tickets.data ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            onRowClick={(row) => setOpenTicketId(openTicketId === row.id ? null : row.id)}
            renderRowDetail={(row) => (row.id === openTicketId ? <TicketDetail ticket={row} /> : null)}
            emptyState={
              <EmptyState
                icon={LifeBuoy}
                title={t("helpdesk.mine.empty.title")}
                hint={t("helpdesk.mine.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </section>

      {/* ── Ask HR for a document ────────────────────────────────────────── */}
      {docSent !== null ? (
        <div className="mt-6"><Notice tone="success">{t("helpdesk.doc.done")}</Notice></div>
      ) : null}

      <SubmitAttemptScope attempt={docAttempt}>
      <section className="mt-6 rounded-lg border bg-card p-4" aria-labelledby="dr-form">
        <h2 id="dr-form" className="flex items-center gap-2 font-display text-lg font-semibold">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t("helpdesk.doc.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.doc.hint")}</p>

        {/*
          A payslip is usually already downloadable, and asking HR for one they
          can fetch themselves costs the employee days and HR an errand. Shown
          only for the payslip kind — the same sentence under "letter for a bank"
          would be wrong, because nobody can self-serve that.
        */}
        {kind === "payslip" ? (
          <Notice tone="info">
            <p className="font-medium">{t("helpdesk.doc.selfServe.title")}</p>
            <p className="mt-1">
              {t("helpdesk.doc.selfServe.hint")}{" "}
              <Link to="/me/payslips" className="font-medium text-primary underline-offset-4 hover:underline">
                {t("helpdesk.doc.selfServe.link")}
              </Link>
            </p>
          </Notice>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="dr-kind">{t("helpdesk.doc.kind")}</Label>
            <select
              id="dr-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {documentKindValues.map((v) => (
                <option key={v} value={v}>{t(`helpdesk.doc.kind.${v}` as MessageKey)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="dr-to">{t("helpdesk.doc.addressedTo")}</Label>
            <Input
              id="dr-to"
              className="mt-1.5 h-11"
              maxLength={200}
              value={addressedTo}
              onChange={(e) => setAddressedTo(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("helpdesk.doc.addressedTo.hint")}</p>
          </div>

          {/*
            Shown only for the kinds that cover a period. An address proof has no
            month, and a date box on it is a box people fill in wrongly.
          */}
          {periodic ? (
            <>
              <div>
                <Label htmlFor="dr-pf">
                  {t("helpdesk.doc.periodFrom")}
                  {/*
                    Starred only where it is genuinely required. A payslip is FOR
                    a month — the server refuses one without a period
                    (`ck_dr__payslip_needs_period`) — while a salary certificate
                    or a Form 16 can be asked for without naming a range.
                    Starring it on every kind would be a lie on two of the three.
                  */}
                  {kind === "payslip" ? <Required /> : null}
                </Label>
                <Input
        required
                  id="dr-pf"
                  type="date"
                  max={today}
                  className="mt-1.5 h-11"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="dr-pt">
                  {t("helpdesk.doc.periodTo")}
                  {kind === "payslip" ? <Required /> : null}
                </Label>
                <Input
        required
                  id="dr-pt"
                  type="date"
                  max={today}
                  min={periodFrom === "" ? undefined : periodFrom}
                  className="mt-1.5 h-11"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-3">
          <Label htmlFor="dr-note">{t("helpdesk.doc.note")}<Required /></Label>
          <textarea
        required
            id="dr-note"
            rows={3}
            maxLength={1000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
        </div>

        {sendDoc.isError ? (
          <div className="mt-3"><Notice tone="error">{mutationUserMessage(sendDoc.error)}</Notice></div>
        ) : null}

        <SubmitBlockers
          attempt={docAttempt}
          blockers={docBlockers}
          id="hd-doc-blockers"
          title={t("helpdesk.doc.blocked.title")}
        />

        <Button
          className="mt-4 w-full"
          disabled={sendDoc.isPending}
          {...blockerButtonProps(docAttempt, docBlockers, "hd-doc-blockers")}
          onClick={() => {
            if (!docAttempt.press(docBlockers)) return;
            sendDoc.mutate(
              {
                documentKind: kind,
                addressedTo,
                note,
                /*
                  Empty means "not asked for", which is NULL — not the empty
                  string, which `date` would reject, and not today, which would
                  silently answer a question the employee did not answer.
                */
                periodFrom: periodic && periodFrom !== "" ? periodFrom : null,
                periodTo: periodic && periodTo !== "" ? periodTo : null,
              },
              {
                onSuccess: (r) => {
                  docAttempt.reset();
                  setDocSent(r.requestId);
                  setNote("");
                  confirmSubmitted(t("helpdesk.doc.done"), {
                    detail: t("helpdesk.doc.toast.next"),
                  });
                },
              },
            );
          }}
        >
          {sendDoc.isPending ? t("helpdesk.doc.sending") : t("helpdesk.doc.send")}
        </Button>

        <p className="mt-3 text-xs text-muted-foreground">{t("helpdesk.doc.track")}</p>
      </section>
      </SubmitAttemptScope>

      {/* ── What they have already asked HR for ──────────────────────────── */}
      {/*
        REPORTED: "if employee has asked somethings then table below list of
        their request".

        The form above raises a DOCUMENT REQUEST, not a helpdesk ticket, so
        nothing it produces appears in "My tickets" — an employee could send three
        payslip requests and this page would look exactly as it did before they
        started. The footnote told them to go and look under Approvals, which is
        a different screen for a thing they raised on this one.

        `OpenRequestsGrid` is the same list the Apply launcher shows, including
        the "With" column that resolves the current approver to a name. Reused
        rather than rebuilt, so a request cannot read one way here and another
        way there.
      */}
      <section className="mt-6" aria-labelledby="dr-mine">
        <h2 id="dr-mine" className="font-display text-lg font-semibold">
          {t("helpdesk.doc.mine.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.doc.mine.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={docRequestsPending}
            error={docRequestsError}
            onRetry={() => {
              void docOnly.refetch();
              void payslipOnly.refetch();
            }}
          >
            <OpenRequestsGrid
              rows={myDocRequests.rows}
              approvers={myDocRequests.approvers}
              emptyTitle={t("helpdesk.doc.mine.empty.title")}
              emptyHint={t("helpdesk.doc.mine.empty.hint")}
            />
          </StateBoundary>
        </div>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.whenReady.title")}</CardTitle>
            <CardDescription>{t("helpdesk.whenReady.hint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>{t("helpdesk.whenReady.item1")}</li>
              <li>{t("helpdesk.whenReady.item2")}</li>
              <li>{t("helpdesk.whenReady.item3")}</li>
              <li>{t("helpdesk.whenReady.item4")}</li>
              <li>{t("helpdesk.whenReady.item5")}</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.today.title")}</CardTitle>
            <CardDescription>{t("helpdesk.today.hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/apply">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.apply")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/policies">
                <ScrollText className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.policies")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/approvals">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.approvals")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
