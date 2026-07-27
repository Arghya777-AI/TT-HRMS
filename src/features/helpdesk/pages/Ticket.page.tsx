/**
 * E-14 · /me/helpdesk/:id — one thread: what was asked, who it is with, the
 * clock it is being answered against, and every word said on it.
 *
 * WHY THIS IS NOT A TICKET SCREEN, AND SAYS SO. `tickets`, `ticket_messages`,
 * `ticket_slas` and `ticket_queues` do not exist in this database (see the gap
 * page at `/me/helpdesk`, and the header of `../api/ticket.api.ts` for the probe).
 * The route promises "the conversation and its service-level clock", and exactly
 * one deployed object has both: the request the employee raised. So this screen
 * opens THAT, names it a request, and states in a banner that the ticket tables
 * are absent. Nothing is relabelled: no ticket number is minted, no queue is
 * implied, and no "0 open tickets" tile pretends a queue exists and is empty.
 *
 * WHAT IS REAL AND WRITABLE HERE. The reply box is not decoration:
 * `public.act_on_approval` accepts `comment` from the subject of a request and
 * `provide_info` from the requester specifically, and the page picks between them
 * by reading the trail — if the last question/answer entry was an approver's
 * `request_info`, the reply is recorded as the ANSWER rather than as a side
 * comment. Withdrawal (`recall`) is offered only when the request type allows it
 * and the request is still open; the server re-checks all of that regardless.
 *
 * The SLA card reads `sla_due_at` and `request_types.sla_hours` and does not
 * recompute either. `sla_breaches` is deliberately not read: its self policy
 * names the APPROVER, not the subject, so an employee's query returns zero rows
 * whether or not the SLA was missed — an empty "no breaches" panel would be a lie
 * about withheld data.
 *
 * @route /me/helpdesk/:id
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft,
  Clock,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Send,
  Undo2,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { MIN_REASON_LENGTH } from "@/shared/api/query";
import { useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  OPEN_THREAD_STATUSES,
  detailTargetFor,
  nextReplyAction,
  type Ticket,
} from "../api/ticket.api";
import { usePostTicketReply, useTicketThread, useWithdrawTicket } from "../hooks/useHelpdesk";

/** `public.approval_status` (migration 003), in the employee's words. */
const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("meTicket.status.draft"), tone: "neutral" },
  pending: { label: t("meTicket.status.pending"), tone: "warn" },
  in_progress: { label: t("meTicket.status.in_progress"), tone: "info" },
  escalated: { label: t("meTicket.status.escalated"), tone: "danger" },
  approved: { label: t("meTicket.status.approved"), tone: "success" },
  rejected: { label: t("meTicket.status.rejected"), tone: "danger" },
  cancelled: { label: t("meTicket.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("meTicket.status.withdrawn"), tone: "neutral" },
  expired: { label: t("meTicket.status.expired"), tone: "danger" },
  auto_approved: { label: t("meTicket.status.auto_approved"), tone: "success" },
  applied: { label: t("meTicket.status.applied"), tone: "success" },
  failed: { label: t("meTicket.status.failed"), tone: "danger" },
};

const PRIORITY_LABEL: Readonly<Record<Ticket["priority"], string>> = {
  low: t("meTicket.priority.low"),
  normal: t("meTicket.priority.normal"),
  high: t("meTicket.priority.high"),
  urgent: t("meTicket.priority.urgent"),
};

/** `public.approval_action` (migration 003) — every value the trail can hold. */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  submit: t("meTicket.action.submit"),
  approve: t("meTicket.action.approve"),
  reject: t("meTicket.action.reject"),
  request_info: t("meTicket.action.request_info"),
  provide_info: t("meTicket.action.provide_info"),
  delegate: t("meTicket.action.delegate"),
  reassign: t("meTicket.action.reassign"),
  escalate: t("meTicket.action.escalate"),
  recall: t("meTicket.action.recall"),
  cancel: t("meTicket.action.cancel"),
  comment: t("meTicket.action.comment"),
  auto_approve: t("meTicket.action.auto_approve"),
  skip_level: t("meTicket.action.skip_level"),
};

const ACTION_DOT_CLASS: Readonly<Record<string, string>> = {
  approve: "text-success",
  auto_approve: "text-success",
  reject: "text-destructive",
  cancel: "text-destructive",
  recall: "text-muted-foreground",
  escalate: "text-destructive",
  request_info: "text-warning",
  provide_info: "text-info",
  comment: "text-info",
};

/** `approval_actions.acted_as` — the four values the CHECK constraint allows. */
const ACTED_AS_LABEL: Readonly<Record<string, string>> = {
  delegate: t("meTicket.thread.asDelegate"),
  escalation: t("meTicket.thread.asEscalation"),
  admin_override: t("meTicket.thread.asAdmin"),
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'request_number' → 'Request number'. Never a raw jsonb key on screen (D-10). */
function humaniseKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Render one value out of the server's `summary` jsonb. A civil date goes through
 * the IST formatter; everything else is shown as the server wrote it. No value is
 * re-derived here — the summary is the server's own rendering of the request.
 */
function summaryValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return dash(null);
  if (typeof value === "string") return ISO_DATE.test(value) ? fmtCivilDate(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The summary's own key/value pairs, or an empty list when it is not an object. */
function summaryEntries(summary: unknown): readonly [string, unknown][] {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) return [];
  return Object.entries(summary as Record<string, unknown>);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const thread = useTicketThread(id);
  const myEmployeeId = useEmployeeId();
  const myProfileId = useProfileId();
  const reply = usePostTicketReply();
  const withdraw = useWithdrawTicket();

  const [draft, setDraft] = useState("");
  const [tooShort, setTooShort] = useState(false);
  const [askWithdraw, setAskWithdraw] = useState(false);

  const data = thread.data ?? null;
  const request = data?.request ?? null;
  const requestType = request?.request_types ?? null;

  // Server facts, read — never derived. `OPEN_THREAD_STATUSES` is the same list
  // `act_on_approval` checks, so an offered control is one the engine accepts.
  const isOpen =
    request !== null && (OPEN_THREAD_STATUSES as readonly string[]).includes(request.status);
  const iAmSubject = request !== null && myEmployeeId !== null && request.subject_employee_id === myEmployeeId;
  const raisedForMe = request !== null && myProfileId !== null && request.raised_by !== myProfileId;
  const canWithdraw = isOpen && iAmSubject && requestType?.allows_withdrawal === true;
  const replyAction = nextReplyAction(data?.actions ?? []);
  const isAnswer = replyAction === "provide_info";
  const detail = request === null ? null : detailTargetFor(request);
  const summary = summaryEntries(request?.summary);

  /**
   * Clear the box only once the server has the reply. Clearing it on submit would
   * throw the employee's words away on a 42501 — and a permanent trail is exactly
   * the place not to make someone retype.
   */
  useEffect(() => {
    if (reply.isSuccess) setDraft("");
  }, [reply.isSuccess]);

  function submitReply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (request === null || reply.isPending) return;
    const text = draft.trim();
    if (!reply.isReasonAcceptable(text)) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    reply.save(
      { requestId: request.id, action: replyAction, reference: request.request_number },
      text,
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={request?.request_number ?? t("meTicket.title")}
        subtitle={request?.title ?? t("meTicket.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("meTicket.back")}
            </Link>
          </Button>
        }
      />

      <Notice tone="warning" className="mb-4">
        {t("meTicket.source")}
      </Notice>

      <StateBoundary
        loading={thread.isPending}
        error={thread.error}
        onRetry={() => void thread.refetch()}
        isEmpty={!thread.isPending && request === null}
        empty={
          <EmptyState
            icon={LifeBuoy}
            title={t("meTicket.notFound.title")}
            hint={t("meTicket.notFound.hint")}
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/me/apply">{t("meTicket.notFound.action")}</Link>
              </Button>
            }
          />
        }
        skeletonRows={5}
      >
        {request === null ? null : (
          <div className="space-y-4">
            {/* ── The request itself ─────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("meTicket.facts.title")}</CardTitle>
                <CardDescription>{dash(requestType?.description ?? null)}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={request.status} map={STATUS_CHIP} />
                  <Badge variant={request.priority === "normal" ? "neutral" : "warning"}>
                    {PRIORITY_LABEL[request.priority]}
                  </Badge>
                  {raisedForMe ? (
                    <Badge variant="info">{t("meTicket.facts.raisedForMe")}</Badge>
                  ) : null}
                </div>

                <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Fact label={t("meTicket.facts.reference")}>
                    <span className="num">{request.request_number}</span>
                  </Fact>
                  <Fact label={t("meTicket.facts.type")}>{dash(requestType?.name ?? null)}</Fact>
                  <Fact label={t("meTicket.facts.level")}>
                    {t("meTicket.facts.levelValue", {
                      level: request.current_level,
                      total: request.total_levels,
                    })}
                  </Fact>
                  <Fact label={t("meTicket.facts.submitted")}>{fmtDateTime(request.submitted_at)}</Fact>
                  <Fact label={t("meTicket.facts.firstAction")}>
                    {dash(request.first_action_at, fmtDateTime)}
                  </Fact>
                  <Fact label={t("meTicket.facts.decided")}>
                    {dash(request.decided_at, fmtDateTime)}
                  </Fact>
                  {request.escalated_at === null ? null : (
                    <Fact label={t("meTicket.facts.escalated")}>
                      {fmtDateTime(request.escalated_at)}
                    </Fact>
                  )}
                  {request.amount === null ? null : (
                    <Fact label={t("meTicket.facts.amount")}>
                      <span className="num">{formatINR(request.amount)}</span>
                    </Fact>
                  )}
                  {request.days === null ? null : (
                    <Fact label={t("meTicket.facts.days")}>
                      <span className="num">{formatDays(request.days)}</span>
                    </Fact>
                  )}
                  {request.decision_comment === null ? null : (
                    <Fact label={t("meTicket.facts.decisionComment")}>{request.decision_comment}</Fact>
                  )}
                  {request.cancellation_reason === null ? null : (
                    <Fact label={t("meTicket.facts.cancellationReason")}>
                      {request.cancellation_reason}
                    </Fact>
                  )}
                </dl>

                <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2">
                  <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    {t("meTicket.facts.waitingOn")}
                  </p>
                  {data !== null && data.approvers.length > 0 ? (
                    <ul className="mt-1.5 space-y-1 text-sm">
                      {data.approvers.map((person) => (
                        <li key={person.id}>
                          {person.display_name}
                          <span className="num text-muted-foreground"> · {person.employee_code}</span>
                          {person.designation_name === null ? null : (
                            <span className="text-muted-foreground"> · {person.designation_name}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      {t("meTicket.facts.noApprover")}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ── The clock ──────────────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4" aria-hidden />
                  {t("meTicket.sla.title")}
                </CardTitle>
                <CardDescription>
                  {requestType === null
                    ? t("meTicket.sla.hint")
                    : t("meTicket.sla.window", { hours: requestType.sla_hours })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="num font-display text-xl font-semibold leading-none">
                  {t("meTicket.sla.due", { when: fmtDateTime(request.sla_due_at) })}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {isOpen
                    ? requestType?.escalation_hours == null
                      ? t("meTicket.sla.noEscalation")
                      : t("meTicket.sla.escalation", { hours: requestType.escalation_hours })
                    : t("meTicket.sla.settled")}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{t("meTicket.sla.hint")}</p>
              </CardContent>
            </Card>

            {/* ── What it is about ───────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("meTicket.detail.title")}</CardTitle>
                <CardDescription>{t("meTicket.detail.hint")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{request.title}</p>

                {summary.length === 0 ? null : (
                  <>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {t("meTicket.detail.summary")}
                    </p>
                    <dl className="grid gap-3 rounded-md border bg-muted/40 px-3 py-2.5 sm:grid-cols-2">
                      {summary.map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            {humaniseKey(key)}
                          </dt>
                          <dd className="num mt-0.5 break-words text-sm">{summaryValue(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}

                {detail === null ? (
                  <p className="text-sm text-muted-foreground">{t("meTicket.detail.noLink")}</p>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link to={detail.to}>
                      {detail.rowSpecific
                        ? t("meTicket.detail.openRow")
                        : t("meTicket.detail.openScreen")}
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* ── The conversation ───────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  {t("meTicket.thread.title")}
                </CardTitle>
                <CardDescription>{t("meTicket.thread.hint")}</CardDescription>
              </CardHeader>
              <CardContent>
                {data === null || data.actions.length === 0 ? (
                  <EmptyState
                    icon={MessageSquare}
                    title={t("meTicket.thread.empty.title")}
                    hint={t("meTicket.thread.empty.hint")}
                  />
                ) : (
                  <ol className="space-y-4">
                    {data.actions.map((action) => {
                      const actor = action.actor_id === null ? null : data.actors.get(action.actor_id);
                      const isMe = action.actor_id !== null && action.actor_id === myProfileId;
                      const actedAs =
                        action.acted_as === null ? null : (ACTED_AS_LABEL[action.acted_as] ?? null);
                      return (
                        <li key={action.id} className="flex gap-3">
                          <span
                            className={cn(
                              "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-current",
                              ACTION_DOT_CLASS[action.action] ?? "text-muted-foreground",
                            )}
                            aria-hidden
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {ACTION_LABEL[action.action] ?? action.action}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {isMe
                                ? t("meTicket.thread.you")
                                : actor === undefined || actor === null
                                  ? t("meTicket.thread.system")
                                  : `${actor.display_name} · ${actor.employee_code}`}
                              {actedAs === null ? "" : ` · ${actedAs}`}
                              {" · "}
                              {fmtDateTime(action.acted_at)}
                              {" · "}
                              {t("meTicket.thread.atLevel", { level: action.level })}
                            </p>
                            {action.comment === null ? null : (
                              <p className="mt-1 break-words text-sm">{action.comment}</p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>

            {/* ── Reply, and withdraw ────────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {isAnswer ? t("meTicket.reply.answerTitle") : t("meTicket.reply.title")}
                </CardTitle>
                <CardDescription>
                  {isAnswer ? t("meTicket.reply.answerHint") : t("meTicket.reply.hint")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!isOpen ? (
                  <EmptyState
                    icon={MessageSquare}
                    title={t("meTicket.reply.closed")}
                    hint={t("meTicket.reply.closedHint")}
                  />
                ) : (
                  <form onSubmit={submitReply} className="space-y-2">
                    <label htmlFor="ticket-reply" className="text-sm font-medium">
                      {t("meTicket.reply.label")}
                    </label>
                    <textarea
                      id="ticket-reply"
                      rows={3}
                      value={draft}
                      disabled={reply.isPending}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setTooShort(false);
                      }}
                      placeholder={t("meTicket.reply.placeholder")}
                      aria-describedby="ticket-reply-hint"
                      aria-invalid={tooShort}
                      className={cn(
                        "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
                        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        tooShort && "border-destructive",
                      )}
                    />
                    <p
                      id="ticket-reply-hint"
                      className={cn("text-xs", tooShort ? "font-medium text-destructive" : "text-muted-foreground")}
                    >
                      {t("meTicket.reply.min", { min: reply.minReasonLength })}
                    </p>

                    {reply.userMessage === null ? null : (
                      <Notice tone="error">{reply.userMessage}</Notice>
                    )}
                    {reply.isSuccess ? <Notice tone="success">{t("meTicket.reply.posted")}</Notice> : null}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button type="submit" size="sm" disabled={reply.isPending}>
                        {reply.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Send className="mr-2 h-4 w-4" aria-hidden />
                        )}
                        {reply.isPending ? t("meTicket.reply.sending") : t("meTicket.reply.send")}
                      </Button>

                      {canWithdraw ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={withdraw.isPending}
                          onClick={() => setAskWithdraw(true)}
                        >
                          <Undo2 className="mr-2 h-4 w-4" aria-hidden />
                          {t("meTicket.withdraw.action")}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("meTicket.withdraw.unavailable")}
                        </span>
                      )}
                    </div>
                  </form>
                )}

                {withdraw.isSuccess ? (
                  <Notice tone="success" className="mt-3">
                    {t("meTicket.withdraw.done")}
                  </Notice>
                ) : null}
              </CardContent>
            </Card>

            <ReasonDialog
              open={askWithdraw}
              title={t("meTicket.withdraw.title", { reference: request.request_number })}
              description={t("meTicket.withdraw.description")}
              minLength={MIN_REASON_LENGTH}
              confirmLabel={t("meTicket.withdraw.confirm")}
              pending={withdraw.isPending}
              errorMessage={withdraw.userMessage}
              onConfirm={(reason) => {
                withdraw.save(
                  { requestId: request.id, reference: request.request_number },
                  reason,
                );
                setAskWithdraw(false);
              }}
              onCancel={() => setAskWithdraw(false)}
            />
          </div>
        )}
      </StateBoundary>
    </div>
  );
}
