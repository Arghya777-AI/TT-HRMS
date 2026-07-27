/**
 * §14 · /admin/comms/broadcasts — the send console. Compose, resolve the
 * audience server-side, dispatch through the `communication-send` edge function.
 *
 * THE HONEST STATE OF THIS SCREEN, verified against the live project rather than
 * assumed:
 *
 *   * The AUDIENCE PREVIEW works. `communication-send` reads its Resend key only
 *     when `dry_run` is false, so a preview returns the real recipient count,
 *     the real "no email address on file" count and ten real names. Probed live:
 *     `{all:true}` resolves to 14 recipients, 7 of them with no email address.
 *   * The SEND does not, and cannot yet. The function secret `RESEND_API_KEY` is
 *     unset on this project and the SMTP failover named in the architecture has
 *     no credentials in the secret inventory, so the commit path answers
 *     503 / `EMAIL_TRANSPORT_UNCONFIGURED` — "nothing is broken, email is simply
 *     not provisioned here". The screen says that BEFORE the admin composes,
 *     and repeats it verbatim if they press Send anyway. Nothing is faked and no
 *     success is ever reported for mail that did not leave.
 *
 * What the request carries (the function's own zod contract): `mode`,
 * `communication_kind`, `audience` (OR-ed selectors, `all` short-circuits),
 * `message` (`template_code`, or `subject` + `body_text`), `dry_run`, and an
 * `Idempotency-Key` header — mandatory on every committing call, one key per
 * mount so a retried send cannot mail twice.
 *
 * `policy` mode is deliberately absent: it requires a `document_id`, and
 * `documents` is empty on this project. Circulating a policy belongs to
 * /admin/comms/policies, which says the same thing.
 *
 * Every number here is the server's: the preview counts come from the function's
 * audience resolver, the history counters (`recipient_count`, `delivered_count`,
 * `opened_count`, `failed_count`) are columns on `communications`.
 *
 * @route /admin/comms/broadcasts
 */
import { useMemo, useState } from "react";
import { Inbox, Send, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { TTApiError } from "@/shared/api/invoke";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/Field";
import { CheckboxField, TextAreaField } from "../components/CommsFields";
import { useRefOptions } from "../hooks/useMasters";
import {
  useBroadcastPreview,
  useBroadcastSend,
  useCommsTemplates,
  useCommunicationCount,
  useCommunications,
} from "../hooks/useCommsAdmin";
import {
  EMAIL_TRANSPORT_UNCONFIGURED,
  type BroadcastMode,
  type Communication,
} from "../api/comms.api";

/** `ck_communications__kind` — the same eight the function accepts. */
const KINDS: readonly { value: string; label: string }[] = [
  { value: "circular", label: t("admin.comms.bc.kind.circular") },
  { value: "reminder", label: t("admin.comms.bc.kind.reminder") },
  { value: "survey", label: t("admin.comms.bc.kind.survey") },
  { value: "onboarding", label: t("admin.comms.bc.kind.onboarding") },
  { value: "offer", label: t("admin.comms.bc.kind.offer") },
  { value: "custom", label: t("admin.comms.bc.kind.custom") },
];

const MODES: readonly { value: BroadcastMode; label: string }[] = [
  { value: "broadcast", label: t("admin.comms.bc.mode.broadcast") },
  { value: "transactional", label: t("admin.comms.bc.mode.transactional") },
];

/** `public.employment_type` — the function's `employment_types` selector. */
const EMPLOYMENT_TYPES: readonly string[] = [
  "permanent",
  "probation",
  "contract",
  "intern",
  "consultant",
  "casual",
  "apprentice",
  "retainer",
];

const SEND_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.comms.bc.status.draft"), tone: "neutral" },
  scheduled: { label: t("admin.comms.bc.status.scheduled"), tone: "info" },
  sending: { label: t("admin.comms.bc.status.sending"), tone: "warn" },
  sent: { label: t("admin.comms.bc.status.sent"), tone: "success" },
  partially_failed: { label: t("admin.comms.bc.status.partiallyFailed"), tone: "danger" },
  cancelled: { label: t("admin.comms.bc.status.cancelled"), tone: "neutral" },
};

type Source = "inline" | "template";

/** True when the function refused because no email transport is provisioned. */
function isTransportUnconfigured(error: unknown): boolean {
  return (
    error instanceof TTApiError &&
    (error.problem.code === EMAIL_TRANSPORT_UNCONFIGURED || error.status === 503)
  );
}

/** The problem sentence the function actually returned, never a bare status. */
function problemSentence(error: unknown): string {
  if (error instanceof TTApiError) {
    return error.problem.detail ?? error.problem.title ?? error.message;
  }
  return error instanceof Error ? error.message : t("admin.comms.bc.send.unknown");
}

function splitEmails(raw: string): string[] {
  return raw
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export default function BroadcastsPage() {
  const [mode, setMode] = useState<BroadcastMode>("broadcast");
  const [kind, setKind] = useState("circular");
  const [source, setSource] = useState<Source>("inline");
  const [templateCode, setTemplateCode] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toEveryone, setToEveryone] = useState(true);
  const [departmentId, setDepartmentId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [externalEmails, setExternalEmails] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const departments = useRefOptions("departments");
  const locations = useRefOptions("locations");
  const emailTemplates = useCommsTemplates({ channels: ["email"], activeOnly: true });

  const preview = useBroadcastPreview();
  const send = useBroadcastSend();
  const history = useCommunications();
  const historyCount = useCommunicationCount();

  const emails = useMemo(() => splitEmails(externalEmails), [externalEmails]);

  const audience = useMemo(
    () => ({
      ...(toEveryone ? { all: true } : {}),
      ...(departmentId !== "" ? { department_ids: [departmentId] } : {}),
      ...(locationId !== "" ? { location_ids: [locationId] } : {}),
      ...(employmentType !== "" ? { employment_types: [employmentType] } : {}),
      ...(emails.length > 0 ? { emails } : {}),
    }),
    [toEveryone, departmentId, locationId, employmentType, emails],
  );

  const hasAudience =
    toEveryone ||
    departmentId !== "" ||
    locationId !== "" ||
    employmentType !== "" ||
    emails.length > 0;
  const hasMessage =
    source === "template"
      ? templateCode !== ""
      : subject.trim().length >= 3 && body.trim().length >= 10;
  const composeReady = hasAudience && hasMessage;

  const request = useMemo(
    () => ({
      mode,
      communicationKind: kind,
      audience,
      ...(source === "template" ? { templateCode } : {}),
      ...(source === "inline" ? { subject: subject.trim(), bodyText: body.trim() } : {}),
    }),
    [mode, kind, audience, source, templateCode, subject, body],
  );

  const runPreview = () => {
    setSubmitted(true);
    if (!composeReady) return;
    send.reset();
    preview.mutate(request);
  };

  const runSend = () => {
    setSubmitted(true);
    if (!composeReady) return;
    send.mutate(request);
  };

  const previewData = preview.data;
  const rows = useMemo(() => history.data ?? [], [history.data]);

  const historyColumns: DataGridColumn<Communication>[] = [
    {
      key: "communication_number",
      header: t("admin.comms.bc.col.number"),
      width: "10rem",
      render: (row) => <span className="font-mono text-xs">{row.communication_number}</span>,
    },
    {
      key: "subject",
      header: t("admin.comms.bc.col.subject"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.subject}</span>
          <span className="text-xs text-muted-foreground">
            {row.communication_kind} · {row.channels.join(", ")}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("admin.comms.bc.col.status"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={SEND_STATUS_CHIP} />,
    },
    {
      key: "recipient_count",
      header: t("admin.comms.bc.col.recipients"),
      align: "right",
      width: "7rem",
      render: (row) => <span className="num">{formatNumber(row.recipient_count)}</span>,
    },
    {
      key: "delivered_count",
      header: t("admin.comms.bc.col.delivered"),
      align: "right",
      width: "7rem",
      hideBelow: "sm",
      render: (row) => <span className="num">{formatNumber(row.delivered_count)}</span>,
    },
    {
      key: "opened_count",
      header: t("admin.comms.bc.col.opened"),
      align: "right",
      width: "7rem",
      hideBelow: "md",
      render: (row) => <span className="num">{formatNumber(row.opened_count)}</span>,
    },
    {
      key: "failed_count",
      header: t("admin.comms.bc.col.failed"),
      align: "right",
      width: "7rem",
      hideBelow: "md",
      render: (row) => (
        <span className={row.failed_count > 0 ? "num text-destructive" : "num"}>
          {formatNumber(row.failed_count)}
        </span>
      ),
    },
    {
      key: "sent_at",
      header: t("admin.comms.bc.col.sentAt"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="text-xs">
          {row.sent_at !== null ? fmtDateTime(row.sent_at) : dash(null)}
        </span>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Send}
        title={t("admin.comms.bc.title")}
        subtitle={t("admin.comms.bc.subtitle")}
      />

      <div className="mb-6">
        <Notice tone="warning">{t("admin.comms.bc.transportNotice")}</Notice>
      </div>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="font-display text-lg font-semibold">{t("admin.comms.bc.compose")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("admin.comms.bc.composeHint")}
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("admin.comms.bc.field.mode")}
              value={mode}
              options={MODES}
              onChange={(v) => setMode(v as BroadcastMode)}
              hint={t("admin.comms.bc.field.modeHint")}
            />
            <SelectField
              label={t("admin.comms.bc.field.kind")}
              value={kind}
              options={KINDS}
              onChange={setKind}
              hint={t("admin.comms.bc.field.kindHint")}
            />
          </div>

          <div className="mt-4 grid gap-4">
            <SelectField
              label={t("admin.comms.bc.field.source")}
              value={source}
              options={[
                { value: "inline", label: t("admin.comms.bc.source.inline") },
                { value: "template", label: t("admin.comms.bc.source.template") },
              ]}
              onChange={(v) => setSource(v as Source)}
              hint={t("admin.comms.bc.field.sourceHint")}
            />
            {source === "template" ? (
              <SelectField
                label={t("admin.comms.bc.field.template")}
                value={templateCode}
                placeholder={t("admin.comms.bc.field.templatePlaceholder")}
                options={(emailTemplates.data ?? []).map((row) => ({
                  value: row.code,
                  label: `${row.name} · ${row.code}`,
                }))}
                onChange={setTemplateCode}
                hint={t("admin.comms.bc.field.templateHint")}
                {...(submitted && templateCode === ""
                  ? { error: t("admin.comms.bc.error.template") }
                  : {})}
              />
            ) : (
              <>
                <TextField
                  label={t("admin.comms.bc.field.subject")}
                  value={subject}
                  onChange={setSubject}
                  required
                  {...(submitted && subject.trim().length < 3
                    ? { error: t("admin.comms.bc.error.subject") }
                    : {})}
                />
                <TextAreaField
                  label={t("admin.comms.bc.field.body")}
                  value={body}
                  onChange={setBody}
                  rows={8}
                  required
                  hint={t("admin.comms.bc.field.bodyHint")}
                  {...(submitted && body.trim().length < 10
                    ? { error: t("admin.comms.bc.error.body") }
                    : {})}
                />
              </>
            )}
          </div>

          <h3 className="mt-6 font-display text-base font-semibold">
            {t("admin.comms.bc.audience")}
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("admin.comms.bc.audienceHint")}
          </p>
          <div className="mt-3 space-y-4">
            <CheckboxField
              label={t("admin.comms.bc.field.everyone")}
              checked={toEveryone}
              onChange={setToEveryone}
              hint={t("admin.comms.bc.field.everyoneHint")}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label={t("admin.comms.bc.field.department")}
                value={departmentId}
                placeholder={t("admin.comms.bc.field.anyDepartment")}
                options={(departments.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                onChange={setDepartmentId}
                disabled={toEveryone}
              />
              <SelectField
                label={t("admin.comms.bc.field.location")}
                value={locationId}
                placeholder={t("admin.comms.bc.field.anyLocation")}
                options={(locations.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                onChange={setLocationId}
                disabled={toEveryone}
              />
              <SelectField
                label={t("admin.comms.bc.field.employmentType")}
                value={employmentType}
                placeholder={t("admin.comms.bc.field.anyEmploymentType")}
                options={EMPLOYMENT_TYPES.map((v) => ({ value: v, label: v }))}
                onChange={setEmploymentType}
                disabled={toEveryone}
              />
            </div>
            <TextField
              label={t("admin.comms.bc.field.externalEmails")}
              value={externalEmails}
              onChange={setExternalEmails}
              hint={t("admin.comms.bc.field.externalEmailsHint")}
              placeholder="name@example.com, other@example.com"
            />
            {submitted && !hasAudience ? (
              <Notice tone="error">{t("admin.comms.bc.error.audience")}</Notice>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={runPreview} disabled={preview.isPending}>
              <Users className="mr-1.5 h-4 w-4" aria-hidden />
              {preview.isPending
                ? t("admin.comms.bc.action.previewing")
                : t("admin.comms.bc.action.preview")}
            </Button>
            <Button
              onClick={runSend}
              disabled={send.isPending || previewData === undefined}
              title={previewData === undefined ? t("admin.comms.bc.action.sendBlocked") : undefined}
            >
              <Send className="mr-1.5 h-4 w-4" aria-hidden />
              {send.isPending
                ? t("admin.comms.bc.action.sending")
                : previewData === undefined
                  ? t("admin.comms.bc.action.send")
                  : t("admin.comms.bc.action.sendN", {
                      n: formatNumber(previewData.recipients.total),
                    })}
            </Button>
          </div>
          <p className="mt-2 text-right text-xs text-muted-foreground">
            {t("admin.comms.bc.action.order")}
          </p>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-display text-lg font-semibold">
              {t("admin.comms.bc.preview.title")}
            </h2>
            {preview.isPending ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t("admin.comms.bc.preview.pending")}
              </p>
            ) : preview.isError ? (
              <div className="mt-3">
                <Notice tone="error">
                  {t("admin.comms.bc.preview.failed", { detail: problemSentence(preview.error) })}
                </Notice>
              </div>
            ) : previewData === undefined ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t("admin.comms.bc.preview.idle")}
              </p>
            ) : (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <KpiTile
                    label={t("admin.comms.bc.preview.total")}
                    value={formatNumber(previewData.recipients.total)}
                    hint={t("admin.comms.bc.preview.totalHint")}
                  />
                  <KpiTile
                    label={t("admin.comms.bc.preview.withoutEmail")}
                    value={formatNumber(previewData.recipients.without_email)}
                    tone={previewData.recipients.without_email > 0 ? "warn" : "success"}
                    hint={t("admin.comms.bc.preview.withoutEmailHint")}
                  />
                </div>
                <p className="mt-3 text-sm">
                  <span className="text-muted-foreground">
                    {t("admin.comms.bc.preview.subject")}{" "}
                  </span>
                  {previewData.subject}
                </p>
                {previewData.recipients.truncated ? (
                  <div className="mt-3">
                    <Notice tone="warning">{t("admin.comms.bc.preview.truncated")}</Notice>
                  </div>
                ) : null}
                <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.bc.preview.names")}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {previewData.preview.map((p) => (
                    <li key={`${p.name}-${p.email ?? "none"}`} className="text-sm">
                      {p.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {p.email ?? t("admin.comms.bc.preview.noEmail")}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {send.isError ? (
            <Notice tone="error">
              {isTransportUnconfigured(send.error)
                ? t("admin.comms.bc.send.transportFailed", {
                    detail: problemSentence(send.error),
                  })
                : t("admin.comms.bc.send.failed", { detail: problemSentence(send.error) })}
            </Notice>
          ) : null}

          {send.data !== undefined ? (
            <Notice tone="success">
              {t("admin.comms.bc.send.done", {
                number: send.data.communication_number,
                status: send.data.status,
                sent: formatNumber(send.data.recipients.sent ?? 0),
                failed: formatNumber(send.data.recipients.failed ?? 0),
              })}
            </Notice>
          ) : null}
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold">{t("admin.comms.bc.history")}</h2>
            <p className="text-sm text-muted-foreground">{t("admin.comms.bc.historyHint")}</p>
          </div>
          <Badge variant="neutral">
            {historyCount.isSuccess
              ? t("admin.comms.bc.historyCount", { n: formatNumber(historyCount.data) })
              : t("admin.comms.bc.historyCountUnknown")}
          </Badge>
        </div>
        <StateBoundary
          loading={history.isPending}
          error={history.error}
          onRetry={() => void history.refetch()}
          isEmpty={rows.length === 0}
          partialError={historyCount.error}
          partialLabel={t("admin.comms.bc.partial.total")}
          empty={
            <EmptyState
              icon={Inbox}
              title={t("admin.comms.bc.empty.title")}
              hint={t("admin.comms.bc.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={historyColumns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.bc.footnote")}</p>
    </div>
  );
}
