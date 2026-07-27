/**
 * §14 · /admin/comms/templates — Message Templates. The copy that goes out for
 * every event, per channel.
 *
 * `public.notification_templates` is one row per (event code × channel): 58 rows
 * live, from the 26 seeded event codes — `in_app` and `email` for each, plus six
 * `sms` rows carrying `DLT-PENDING-*` placeholders because the TRAI/DLT
 * registration has not happened.
 *
 * This screen is the CONTENT lens. /admin/settings/notifications is the
 * *channel* lens and owns switching a template on or off; this one owns the
 * words, and the two do not overlap:
 *
 *  * Editing is real. The table is `FOR ALL` to `app.is_admin()` with
 *    `GRANT SELECT, INSERT, UPDATE`, so the grants allow a rewrite — including
 *    of a seeded `is_system` row.
 *  * There is NO template-version table anywhere in the schema. The audit
 *    trigger on this table (migration 038) is the entire history, so the reason
 *    dialog is where the "why" is captured and the screen says out loud that
 *    rolling back means reading `audit_log`.
 *  * SMS copy is capped at 160 characters by
 *    `ck_notification_templates__sms_length`, so the editor counts characters
 *    rather than letting the database refuse the save.
 *
 * Merge tokens are shown, never evaluated: a template body is data here.
 *
 * @route /admin/comms/templates
 */
import { useMemo, useState } from "react";
import { FileText, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import { TextAreaField } from "../components/CommsFields";
import { channelLabel } from "../kiosk-display";
import { useCommsTemplateCount, useCommsTemplates, useUpdateTemplateCopy } from "../hooks/useCommsAdmin";
import {
  SMS_TEMPLATE_MAX_LENGTH,
  notificationChannelSchema,
  type CommsTemplate,
  type NotificationChannel,
  type TemplateFilters,
} from "../api/comms.api";

const STATE_MAP = {
  active: { label: t("admin.comms.tpl.state.active"), tone: "success" as const },
  inactive: { label: t("admin.comms.tpl.state.inactive"), tone: "neutral" as const },
};

/**
 * `variables` is jsonb the seeds may or may not have filled. Both shapes the
 * schema permits are read; anything else is reported as "declared but not a list"
 * rather than rendered as `[object Object]`.
 */
function tokenList(variables: unknown): string[] {
  if (Array.isArray(variables)) {
    return variables.filter((v): v is string => typeof v === "string");
  }
  if (variables !== null && typeof variables === "object") {
    return Object.keys(variables as Record<string, unknown>);
  }
  return [];
}

/** The `{{token}}` placeholders actually present in a body — the honest list. */
function tokensInBody(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const token = match[1];
    if (token !== undefined) found.add(token);
  }
  return [...found].sort((a, b) => a.localeCompare(b, "en-IN"));
}

interface EditorState {
  subject: string;
  body: string;
  sms: string;
}

function editorFrom(row: CommsTemplate): EditorState {
  return {
    subject: row.subject_template ?? "",
    body: row.body_template,
    sms: row.sms_template ?? "",
  };
}

export default function CommsTemplatesPage() {
  const [channel, setChannel] = useState<NotificationChannel | "">("");
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [transactionalOnly, setTransactionalOnly] = useState(false);
  const [selected, setSelected] = useState<CommsTemplate | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [savedCode, setSavedCode] = useState<string | null>(null);

  const filters = useMemo<TemplateFilters>(
    () => ({
      ...(channel !== "" ? { channels: [channel] } : {}),
      ...(activeOnly ? { activeOnly: true } : {}),
      ...(transactionalOnly ? { transactionalOnly: true } : {}),
      ...(search.trim() !== "" ? { codeLike: search.trim() } : {}),
    }),
    [channel, activeOnly, transactionalOnly, search],
  );

  const list = useCommsTemplates(filters);
  const total = useCommsTemplateCount(filters);
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Server counts, one per channel — the same predicate builder as the grid.
  const allCount = useCommsTemplateCount({});
  const emailCount = useCommsTemplateCount({ channels: ["email"] });
  const inAppCount = useCommsTemplateCount({ channels: ["in_app"] });
  const smsCount = useCommsTemplateCount({ channels: ["sms"] });

  const save = useUpdateTemplateCopy((row) => {
    setSavedCode(row.code);
    setSelected(null);
    setEditor(null);
  });

  const open = (row: CommsTemplate) => {
    setSavedCode(null);
    setSelected(row);
    setEditor(editorFrom(row));
  };

  const smsTooLong =
    selected?.channel === "sms" && editor !== null && editor.sms.length > SMS_TEMPLATE_MAX_LENGTH;
  const bodyTooShort = editor !== null && editor.body.trim().length < 5;

  const anyFilter = channel !== "" || search.trim() !== "" || activeOnly || transactionalOnly;
  const clearAll = () => {
    setChannel("");
    setSearch("");
    setActiveOnly(false);
    setTransactionalOnly(false);
  };

  const columns: DataGridColumn<CommsTemplate>[] = [
    {
      key: "event",
      header: t("admin.comms.tpl.col.event"),
      sortable: true,
      sortValue: (row) => row.code,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "channel",
      header: t("admin.comms.tpl.col.channel"),
      width: "9rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col items-start gap-1 leading-tight">
          <span className="text-sm">{channelLabel(row.channel)}</span>
          {row.dlt_template_id !== null ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {row.dlt_template_id}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "copy",
      header: t("admin.comms.tpl.col.copy"),
      hideBelow: "md",
      render: (row) => (
        <span className="block max-w-md truncate text-xs text-muted-foreground">
          {dash(row.subject_template ?? row.sms_template ?? row.body_template)}
        </span>
      ),
    },
    {
      key: "locale",
      header: t("admin.comms.tpl.col.locale"),
      width: "6.5rem",
      hideBelow: "lg",
      render: (row) => <span className="font-mono text-xs">{row.locale}</span>,
    },
    {
      key: "flags",
      header: t("admin.comms.tpl.col.flags"),
      width: "13rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusChip status={row.is_active ? "active" : "inactive"} map={STATE_MAP} />
          {row.is_transactional ? (
            <Badge variant="info">{t("admin.comms.tpl.transactional")}</Badge>
          ) : null}
          {row.is_system ? <Badge variant="outline">{t("admin.comms.tpl.seeded")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("admin.comms.tpl.col.actions"),
      align: "right",
      width: "8rem",
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => open(row)}>
          {t("admin.comms.tpl.action.open")}
        </Button>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileText}
        title={t("admin.comms.tpl.title")}
        subtitle={
          total.isSuccess
            ? t("admin.comms.tpl.subtitle", { n: formatNumber(total.data) })
            : t("admin.comms.tpl.subtitlePlain")
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.comms.tpl.kpi.all")}
          value={allCount.isSuccess ? formatNumber(allCount.data) : dash(null)}
          hint={t("admin.comms.tpl.kpi.allHint")}
        />
        <KpiTile
          label={t("admin.comms.tpl.kpi.email")}
          value={emailCount.isSuccess ? formatNumber(emailCount.data) : dash(null)}
          hint={t("admin.comms.tpl.kpi.emailHint")}
        />
        <KpiTile
          label={t("admin.comms.tpl.kpi.inApp")}
          value={inAppCount.isSuccess ? formatNumber(inAppCount.data) : dash(null)}
          hint={t("admin.comms.tpl.kpi.inAppHint")}
        />
        <KpiTile
          label={t("admin.comms.tpl.kpi.sms")}
          value={smsCount.isSuccess ? formatNumber(smsCount.data) : dash(null)}
          tone="warn"
          hint={t("admin.comms.tpl.kpi.smsHint")}
        />
      </section>

      <div className="mb-4">
        <Notice tone="warning">{t("admin.comms.tpl.smsNotice")}</Notice>
      </div>

      {savedCode !== null ? (
        <div className="mb-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setSavedCode(null)}>
                {t("admin.comms.tpl.dismiss")}
              </Button>
            }
          >
            {t("admin.comms.tpl.saved", { code: savedCode })}
          </Notice>
        </div>
      ) : null}

      <StateBoundary
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        isEmpty={rows.length === 0}
        partialError={total.error}
        partialLabel={t("admin.comms.tpl.partial.total")}
        empty={
          <EmptyState
            icon={MessageSquare}
            title={t("admin.comms.tpl.empty.title")}
            hint={
              anyFilter ? t("admin.comms.tpl.empty.filteredHint") : t("admin.comms.tpl.empty.hint")
            }
            {...(anyFilter
              ? {
                  action: (
                    <Button variant="outline" onClick={clearAll}>
                      {t("admin.comms.tpl.filter.clear")}
                    </Button>
                  ),
                }
              : {})}
          />
        }
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          onRowClick={open}
          toolbar={
            <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SelectField
                label={t("admin.comms.tpl.filter.channel")}
                value={channel}
                placeholder={t("admin.comms.tpl.filter.anyChannel")}
                options={notificationChannelSchema.options.map((c) => ({
                  value: c,
                  label: channelLabel(c),
                }))}
                onChange={(v) => setChannel(v as NotificationChannel | "")}
              />
              <TextField
                label={t("admin.comms.tpl.filter.search")}
                value={search}
                onChange={setSearch}
                placeholder={t("admin.comms.tpl.filter.searchPlaceholder")}
              />
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={activeOnly ? "default" : "outline"}
                  aria-pressed={activeOnly}
                  onClick={() => setActiveOnly((v) => !v)}
                >
                  {t("admin.comms.tpl.filter.activeOnly")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={transactionalOnly ? "default" : "outline"}
                  aria-pressed={transactionalOnly}
                  onClick={() => setTransactionalOnly((v) => !v)}
                >
                  {t("admin.comms.tpl.filter.transactionalOnly")}
                </Button>
              </div>
              <div className="flex items-end justify-end gap-2">
                {anyFilter ? (
                  <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
                    {t("admin.comms.tpl.filter.clear")}
                  </Button>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {total.isSuccess
                    ? t("admin.comms.tpl.matching", { n: formatNumber(total.data) })
                    : t("admin.comms.tpl.matchingUnknown")}
                </p>
              </div>
            </div>
          }
        />
      </StateBoundary>

      {selected !== null && editor !== null ? (
        <section className="mt-6 rounded-lg border bg-card p-4" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-semibold">{selected.name}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{selected.code}</span> ·{" "}
                {channelLabel(selected.channel)} · {selected.locale} ·{" "}
                {t("admin.comms.tpl.updatedAt", { at: fmtDateTime(selected.updated_at) })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(null);
                setEditor(null);
              }}
            >
              {t("admin.comms.tpl.close")}
            </Button>
          </div>

          {selected.description !== null ? (
            <p className="mt-2 text-sm text-muted-foreground">{selected.description}</p>
          ) : null}

          <div className="mt-4 space-y-4">
            {selected.channel === "sms" ? null : (
              <TextField
                label={t("admin.comms.tpl.editor.subject")}
                value={editor.subject}
                onChange={(v) => setEditor((e) => (e === null ? e : { ...e, subject: v }))}
                hint={t("admin.comms.tpl.editor.subjectHint")}
              />
            )}
            <TextAreaField
              label={t("admin.comms.tpl.editor.body")}
              value={editor.body}
              onChange={(v) => setEditor((e) => (e === null ? e : { ...e, body: v }))}
              rows={10}
              mono
              required
              hint={t("admin.comms.tpl.editor.bodyHint")}
              {...(bodyTooShort ? { error: t("admin.comms.tpl.editor.bodyError") } : {})}
            />
            {selected.channel === "sms" ? (
              <TextAreaField
                label={t("admin.comms.tpl.editor.sms")}
                value={editor.sms}
                onChange={(v) => setEditor((e) => (e === null ? e : { ...e, sms: v }))}
                rows={4}
                mono
                maxLength={SMS_TEMPLATE_MAX_LENGTH}
                hint={t("admin.comms.tpl.editor.smsHint")}
                {...(smsTooLong ? { error: t("admin.comms.tpl.editor.smsError") } : {})}
              />
            ) : null}

            <div className="rounded-md border border-dashed p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("admin.comms.tpl.editor.tokens")}
              </p>
              <p className="mt-1.5 flex flex-wrap gap-1">
                {tokensInBody(editor.body).length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("admin.comms.tpl.editor.noTokens")}
                  </span>
                ) : (
                  tokensInBody(editor.body).map((token) => (
                    <Badge key={token} variant="neutral" className="font-mono">
                      {`{{${token}}}`}
                    </Badge>
                  ))
                )}
              </p>
              {tokenList(selected.variables).length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("admin.comms.tpl.editor.declared", {
                    tokens: tokenList(selected.variables).join(", "),
                  })}
                </p>
              ) : null}
            </div>

            {save.userMessage !== null ? (
              <Notice tone="error">{save.userMessage}</Notice>
            ) : null}
            <Notice tone="info">{t("admin.comms.tpl.editor.historyNote")}</Notice>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setEditor(editorFrom(selected))}
                disabled={save.isPending}
              >
                {t("admin.comms.tpl.editor.revert")}
              </Button>
              <ReasonActionButton
                label={t("admin.comms.tpl.editor.save")}
                variant="default"
                size="default"
                title={t("admin.comms.tpl.editor.confirmTitle", { name: selected.name })}
                description={t("admin.comms.tpl.editor.confirmDescription", {
                  code: selected.code,
                  channel: channelLabel(selected.channel),
                })}
                minLength={15}
                disabled={save.isPending || smsTooLong || bodyTooShort}
                disabledHint={t("admin.comms.tpl.editor.disabledHint")}
                onConfirm={(reason) =>
                  save.saveAsync(
                    {
                      id: selected.id,
                      subjectTemplate: editor.subject.trim() === "" ? null : editor.subject,
                      bodyTemplate: editor.body,
                      smsTemplate: editor.sms.trim() === "" ? null : editor.sms,
                    },
                    reason,
                  )
                }
              />
            </div>
          </div>
        </section>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.tpl.footnote")}</p>
    </div>
  );
}
