/**
 * §14 · /admin/analytics/scheduled — Scheduled Reports.
 *
 * ── WHAT THIS SCREEN USED TO BE, AND WHY IT CHANGED ─────────────────────────
 *
 * For its whole life this page showed an INVENTORY: a table naming the three
 * pieces a real scheduled-reports feature needed — `scheduled_reports`,
 * `scheduled_report_recipients`, and a render-and-deliver function — with two of
 * them marked missing. That was the right call at the time. A working "Add
 * schedule" form over nothing would have been a lie the client could click.
 *
 * Migration 043400 built the two tables, so the form is real now. The third piece
 * is still missing and this screen says so at the top, in plain words, above
 * everything else.
 *
 * ── RECORDING IS NOT SENDING, AND THE SCREEN NEVER BLURS THE TWO ────────────
 *
 * Nothing renders a report or hands it to the mailer. So:
 *
 *  · The delivery gap is stated FIRST, before the register, not as a footnote
 *    somebody scrolls past.
 *  · "Last sent" reads `last_dispatched_at` — a real column, NULL on every row —
 *    rather than being inferred from `is_enabled`. An enabled schedule that has
 *    never fired says "Never sent", which is the truth and is meant to look
 *    slightly wrong.
 *  · No "Send now" button. There is nothing to call.
 *
 * Writing the schedule down is still worth doing: a recurring report that lives
 * only in one person's head stops when they take a week off, and the decision —
 * what, to whom, how often — is the part that takes a conversation. The rendering
 * is the easy half, and it can be built against a register that already has rows.
 *
 * @route /admin/analytics/scheduled
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Cog, Gauge, Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Required } from "@/shared/ui/Required";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import {
  SubmitAttemptScope,
  SubmitBlockers,
  blockerButtonProps,
  useSubmitAttempt,
} from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { mutationUserMessage } from "@/shared/api/query";
import { dash } from "@/lib/format";
import { fmtDateTime } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import {
  SCHEDULE_PRESETS,
  reportFormatValues,
  reportSubjectValues,
  type ReportFormat,
  type ReportSubject,
  type ScheduledReport,
} from "../api/scheduled-reports.api";
import {
  useAddRecipient,
  useCreateScheduledReport,
  useReportRecipients,
  useScheduledReports,
  useSetScheduleEnabled,
} from "../hooks/useScheduledReports";
import { useCompanies } from "../hooks/useMasters";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";

const BLOCKER_ID = "sched-blockers";

const STATE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  on: { label: t("admin.asched.state.on"), tone: "success" },
  off: { label: t("admin.asched.state.off"), tone: "neutral" },
};

export default function AnalyticsScheduledPage() {
  const reports = useScheduledReports();
  const companies = useCompanies();
  const create = useCreateScheduledReport();
  const toggle = useSetScheduleEnabled();
  const attempt = useSubmitAttempt();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [subject, setSubject] = useState<ReportSubject>("attendance_muster");
  const [format, setFormat] = useState<ReportFormat>("csv");
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[1].key);
  const [openFor, setOpenFor] = useState<ScheduledReport | null>(null);

  const companyId = companies.data?.[0]?.id ?? null;
  const chosenPreset = SCHEDULE_PRESETS.find((p) => p.key === preset) ?? SCHEDULE_PRESETS[1];

  const blockers: string[] = [];
  if (companyId === null) blockers.push(t("admin.asched.new.blocked.company"));
  if (code.trim() === "") blockers.push(t("admin.asched.new.blocked.code"));
  if (name.trim() === "") blockers.push(t("admin.asched.new.blocked.name"));

  const columns: DataGridColumn<ScheduledReport>[] = [
    {
      key: "name",
      header: t("admin.asched.col.name"),
      render: (row) => (
        <div>
          <p className="font-medium leading-snug">{row.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
        </div>
      ),
    },
    {
      key: "subject",
      header: t("admin.asched.col.subject"),
      render: (row) => (
        <span>
          {t(`admin.asched.subject.${row.subject}` as MessageKey)}
          <span className="ml-1.5 text-xs uppercase text-muted-foreground">{row.format}</span>
        </span>
      ),
    },
    {
      key: "schedule_human",
      header: t("admin.asched.col.when"),
      hideBelow: "md",
      /* The sentence the author chose, stored beside the cron. Not rendered from
         `0 7 * * 1` in the browser — that would be a second implementation of
         something already decided when they picked it. */
      render: (row) => row.schedule_human,
    },
    {
      key: "last_dispatched_at",
      header: t("admin.asched.col.lastSent"),
      width: "12rem",
      /*
        THE HONEST COLUMN. Reads the real instant, which is NULL on every row
        because nothing dispatches these yet. Inferring "sent" from `is_enabled`
        would turn this whole screen into a claim it cannot support.
      */
      render: (row) =>
        row.last_dispatched_at === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.asched.never")}</span>
        ) : (
          fmtDateTime(row.last_dispatched_at)
        ),
    },
    {
      key: "is_enabled",
      header: t("admin.asched.col.state"),
      width: "8rem",
      render: (row) => <StatusChip status={row.is_enabled ? "on" : "off"} map={STATE_CHIP} />,
    },
    {
      key: "actions",
      header: "",
      width: "13rem",
      render: (row) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setOpenFor(row)}>
            <UserPlus className="mr-1.5 size-3.5" aria-hidden />
            {t("admin.asched.col.recipients")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate({ reportId: row.id, enabled: !row.is_enabled })}
          >
            {row.is_enabled ? t("admin.asched.action.pause") : t("admin.asched.action.resume")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <SubmitAttemptScope attempt={attempt}>
      <div className="container py-6">
        <PageHeader
          icon={CalendarClock}
          title={t("admin.asched.title")}
          subtitle={t("admin.asched.subtitle")}
          actions={
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <Link to="/admin/settings/notifications">
                  <Cog className="mr-2 size-4" aria-hidden />
                  {t("admin.asched.toTemplates")}
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/admin/settings/health">
                  <Gauge className="mr-2 size-4" aria-hidden />
                  {t("admin.asched.toHealth")}
                </Link>
              </Button>
            </div>
          }
        />

        {/*
          FIRST, not last. The one thing somebody must know before they read a
          register of schedules is that none of them fires.
        */}
        <div className="mt-4">
          <Notice tone="note">{t("admin.asched.undelivered")}</Notice>
        </div>

        <section className="mt-6" aria-labelledby="sched-list">
          <h2 id="sched-list" className="font-display text-lg font-semibold">
            {t("admin.asched.reg.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("admin.asched.reg.hint")}</p>
          <StateBoundary
            loading={reports.isLoading}
            error={reports.error ?? undefined}
            onRetry={() => void reports.refetch()}
            isEmpty={reports.data !== undefined && reports.data.length === 0}
            empty={
              <EmptyState
                icon={CalendarClock}
                title={t("admin.asched.reg.empty.title")}
                hint={t("admin.asched.reg.empty.hint")}
              />
            }
            skeletonRows={3}
          >
            <DataGrid rows={reports.data ?? []} columns={columns} rowKey={(r) => r.id} />
          </StateBoundary>
        </section>

        {openFor === null ? null : (
          <RecipientPanel report={openFor} onClose={() => setOpenFor(null)} />
        )}

        {/* ── Schedule one ────────────────────────────────────────────────── */}
        <section className="mt-6 rounded-lg border bg-card p-4" aria-labelledby="sched-new">
          <h2 id="sched-new" className="font-display text-lg font-semibold">
            {t("admin.asched.new.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.asched.new.hint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="sr-code">
                {t("admin.asched.new.code")}
                <Required />
              </Label>
              <Input
                required
                id="sr-code"
                className="mt-1.5 h-11"
                maxLength={40}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.asched.new.code.hint")}
              </p>
            </div>

            <div>
              <Label htmlFor="sr-name">
                {t("admin.asched.new.name")}
                <Required />
              </Label>
              <Input
                required
                id="sr-name"
                className="mt-1.5 h-11"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="sr-subject">{t("admin.asched.new.subject")}</Label>
              <select
                id="sr-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value as ReportSubject)}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reportSubjectValues.map((v) => (
                  <option key={v} value={v}>
                    {t(`admin.asched.subject.${v}` as MessageKey)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="sr-when">{t("admin.asched.new.when")}</Label>
              <select
                id="sr-when"
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.human}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="sr-format">{t("admin.asched.new.format")}</Label>
              <select
                id="sr-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ReportFormat)}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reportFormatValues.map((v) => (
                  <option key={v} value={v}>
                    {v.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <Label htmlFor="sr-desc">{t("admin.asched.new.description")}</Label>
              <Input
                id="sr-desc"
                className="mt-1.5 h-11"
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          {create.isError ? (
            <div className="mt-3">
              <Notice tone="error">{mutationUserMessage(create.error)}</Notice>
            </div>
          ) : null}

          <SubmitBlockers
            attempt={attempt}
            blockers={blockers}
            id={BLOCKER_ID}
            title={t("admin.asched.new.blocked.title")}
          />

          <Button
            className="mt-4"
            disabled={create.isPending}
            {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}
            onClick={() => {
              if (!attempt.press(blockers)) return;
              if (companyId === null) return;
              create.mutate(
                {
                  companyId,
                  code,
                  name,
                  description: description.trim() === "" ? null : description,
                  subject,
                  format,
                  scheduleCron: chosenPreset.cron,
                  scheduleHuman: chosenPreset.human,
                },
                {
                  onSuccess: () => {
                    attempt.reset();
                    setCode("");
                    setName("");
                    setDescription("");
                    confirmSubmitted(t("admin.asched.new.done"), {
                      detail: t("admin.asched.new.doneDetail"),
                    });
                  },
                },
              );
            }}
          >
            <Plus className="mr-2 size-4" aria-hidden />
            {create.isPending ? t("admin.asched.new.submitting") : t("admin.asched.new.submit")}
          </Button>
        </section>
      </div>
    </SubmitAttemptScope>
  );
}

/**
 * Who receives one schedule.
 *
 * Its own component so the recipient reads only fire for the report actually
 * opened — a list of twenty schedules would otherwise mean twenty recipient
 * queries nobody asked for.
 */
function RecipientPanel({
  report,
  onClose,
}: {
  readonly report: ScheduledReport;
  readonly onClose: () => void;
}) {
  const recipients = useReportRecipients(report.id);
  const people = useEmployeeLabels();
  const add = useAddRecipient();
  const [employeeId, setEmployeeId] = useState("");
  const [email, setEmail] = useState("");

  const options = Array.from(people.data ?? new Map<string, { name: string; code: string }>())
    .map(([id, label]) => ({ id, name: `${label.name} · ${label.code}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="mt-4 rounded-lg border bg-muted/20 p-4" aria-labelledby="sched-rec">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="sched-rec" className="font-display text-base font-semibold">
            {t("admin.asched.rec.title", { name: report.name })}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.asched.rec.hint")}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("admin.asched.rec.close")}
        </Button>
      </div>

      <StateBoundary
        loading={recipients.isLoading}
        error={recipients.error ?? undefined}
        onRetry={() => void recipients.refetch()}
        skeletonRows={1}
      >
        {(recipients.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("admin.asched.rec.empty")}</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {(recipients.data ?? []).map((r) => (
              <li key={r.id} className="rounded-md border bg-background px-2.5 py-1 text-sm">
                {r.employee_id === null
                  ? r.email
                  : (people.data?.get(r.employee_id)?.name ?? dash(null))}
              </li>
            ))}
          </ul>
        )}
      </StateBoundary>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sr-emp">{t("admin.asched.rec.addEmployee")}</Label>
          <div className="mt-1.5 flex gap-2">
            <select
              id="sr-emp"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("admin.asched.rec.pick")}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              disabled={employeeId === "" || add.isPending}
              onClick={() => {
                add.mutate(
                  { reportId: report.id, employeeId, email: null },
                  { onSuccess: () => setEmployeeId("") },
                );
              }}
            >
              {t("admin.asched.rec.add")}
            </Button>
          </div>
        </div>

        <div>
          <Label htmlFor="sr-email">{t("admin.asched.rec.addEmail")}</Label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="sr-email"
              type="email"
              className="h-11"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={email.trim() === "" || add.isPending}
              onClick={() => {
                add.mutate(
                  { reportId: report.id, employeeId: null, email },
                  { onSuccess: () => setEmail("") },
                );
              }}
            >
              {t("admin.asched.rec.add")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.asched.rec.emailHint")}
          </p>
        </div>
      </div>

      {add.isError ? (
        <div className="mt-3">
          <Notice tone="error">{mutationUserMessage(add.error)}</Notice>
        </div>
      ) : null}
    </section>
  );
}
