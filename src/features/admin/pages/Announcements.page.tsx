/**
 * §14 · /admin/comms/announcements — the noticeboard an admin actually writes to.
 *
 * `public.announcements` (migration 027 §1) is the only comms table in this
 * project with a live, verified write path from the browser: `FOR ALL` to
 * `app.is_admin()`, `GRANT SELECT, INSERT, UPDATE`, `DELETE` revoked. Insert,
 * update, publish and soft-delete were each exercised against the live project
 * before this screen was written, so nothing here is hopeful.
 *
 * Three things this screen is careful about:
 *
 *  1. DRAFT, PUBLISH AND ARCHIVE ARE DIFFERENT ACTS. Saving copy is a routine
 *     edit. Publishing makes it visible to every matching employee through
 *     `app.announcement_visible()`, so it asks for a 15-character reason and
 *     stamps `published_at`/`published_by` explicitly — no trigger fills them,
 *     and a published notice with no publisher is not an audit trail.
 *  2. THE AUDIENCE IS THE POLICY. `audience` is the jsonb that
 *     `app.announcement_visible()` matches against: `{all:true}`, or department /
 *     location / employment-type / employee lists. An empty object means NOBODY
 *     can see the notice, so the form refuses to save one.
 *  3. ARCHIVED ROWS ARE OPT-IN AND LABELLED. `announcements__admin__all` has no
 *     `deleted_at` predicate, so an admin sees soft-deleted rows unless the
 *     screen excludes them. The default view is live rows; the archive view
 *     shows only the deleted ones and says so.
 *
 * `view_count` is displayed but never derived — the noticeboard read path stamps
 * it. Every tile number is a `HEAD … count=exact` over the same predicate
 * builder as the list.
 *
 * @route /admin/comms/announcements
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, Megaphone, Pin, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtDateTime, istWallClockToInstant, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import { CheckboxField, TextAreaField } from "../components/CommsFields";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import {
  useAnnouncementCount,
  useAnnouncements,
  useArchiveAnnouncement,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  usePublishAnnouncement,
  useRestoreAnnouncement,
  useUpdateAnnouncement,
} from "../hooks/useCommsAdmin";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  announcementKindSchema,
  announcementPrioritySchema,
  announcementStatusSchema,
  type Announcement,
  type AnnouncementFilters,
  type AnnouncementKind,
  type AnnouncementPriority,
  type AnnouncementStatus,
  type Audience,
} from "../api/comms.api";

const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.comms.ann.status.draft"), tone: "neutral" },
  scheduled: { label: t("admin.comms.ann.status.scheduled"), tone: "info" },
  published: { label: t("admin.comms.ann.status.published"), tone: "success" },
  archived: { label: t("admin.comms.ann.status.archived"), tone: "neutral" },
};

const KIND_LABEL: Readonly<Record<AnnouncementKind, string>> = {
  general: t("admin.comms.ann.kind.general"),
  policy_change: t("admin.comms.ann.kind.policyChange"),
  event_briefing: t("admin.comms.ann.kind.eventBriefing"),
  celebration: t("admin.comms.ann.kind.celebration"),
  safety_alert: t("admin.comms.ann.kind.safetyAlert"),
  roster_published: t("admin.comms.ann.kind.rosterPublished"),
  holiday_notice: t("admin.comms.ann.kind.holidayNotice"),
};

const PRIORITY_LABEL: Readonly<Record<AnnouncementPriority, string>> = {
  low: t("admin.comms.ann.priority.low"),
  normal: t("admin.comms.ann.priority.normal"),
  high: t("admin.comms.ann.priority.high"),
  critical: t("admin.comms.ann.priority.critical"),
};

const PRIORITY_VARIANT: Readonly<
  Record<AnnouncementPriority, "neutral" | "info" | "warning" | "danger">
> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  critical: "danger",
};

function kindLabel(kind: string): string {
  const parsed = announcementKindSchema.safeParse(kind);
  return parsed.success ? KIND_LABEL[parsed.data] : kind;
}

function priorityLabel(priority: string): string {
  const parsed = announcementPrioritySchema.safeParse(priority);
  return parsed.success ? PRIORITY_LABEL[parsed.data] : priority;
}

function priorityVariant(priority: string): "neutral" | "info" | "warning" | "danger" {
  const parsed = announcementPrioritySchema.safeParse(priority);
  return parsed.success ? PRIORITY_VARIANT[parsed.data] : "neutral";
}

// -----------------------------------------------------------------------------
// Audience
// -----------------------------------------------------------------------------

type AudienceScope = "all" | "targeted";

/** One readable line for the jsonb the visibility function will match against. */
function audienceSummary(
  audience: Audience,
  names: { departments: ReadonlyMap<string, string>; locations: ReadonlyMap<string, string> },
): string {
  if (audience.all === true) return t("admin.comms.ann.audience.everyone");
  const parts: string[] = [];
  for (const id of audience.department_ids ?? []) {
    parts.push(names.departments.get(id) ?? t("admin.comms.ann.audience.unknownRef"));
  }
  for (const id of audience.location_ids ?? []) {
    parts.push(names.locations.get(id) ?? t("admin.comms.ann.audience.unknownRef"));
  }
  for (const type of audience.employment_types ?? []) parts.push(type);
  const employees = audience.employee_ids ?? [];
  if (employees.length > 0) {
    parts.push(t("admin.comms.ann.audience.namedPeople", { n: formatNumber(employees.length) }));
  }
  return parts.length === 0 ? t("admin.comms.ann.audience.nobody") : parts.join(" · ");
}

// -----------------------------------------------------------------------------
// The compose form
// -----------------------------------------------------------------------------

interface FormState {
  title: string;
  body: string;
  kind: AnnouncementKind;
  priority: AnnouncementPriority;
  pinned: boolean;
  requiresAck: boolean;
  scope: AudienceScope;
  departmentId: string;
  locationId: string;
  publishDate: string;
  publishTime: string;
  expiryDate: string;
  expiryTime: string;
}

const EMPTY_FORM: FormState = {
  title: "",
  body: "",
  kind: "general",
  priority: "normal",
  pinned: false,
  requiresAck: false,
  scope: "all",
  departmentId: "",
  locationId: "",
  publishDate: "",
  publishTime: "",
  expiryDate: "",
  expiryTime: "",
};

function formFromRow(row: Announcement): FormState {
  const audience = row.audience;
  const departmentId = (audience.department_ids ?? [])[0] ?? "";
  const locationId = (audience.location_ids ?? [])[0] ?? "";
  const kind = announcementKindSchema.safeParse(row.announcement_kind);
  const priority = announcementPrioritySchema.safeParse(row.priority);
  return {
    ...EMPTY_FORM,
    title: row.title,
    body: row.body_markdown,
    kind: kind.success ? kind.data : "general",
    priority: priority.success ? priority.data : "normal",
    pinned: row.pinned,
    requiresAck: row.requires_acknowledgement,
    scope: audience.all === true ? "all" : "targeted",
    departmentId,
    locationId,
  };
}

const TIME_PATTERN = /^\d{2}:\d{2}$/;

interface FormProblems {
  title?: string;
  body?: string;
  publishTime?: string;
  expiryTime?: string;
  audience?: string;
  form?: string;
}

function validate(form: FormState): FormProblems {
  const problems: FormProblems = {};
  if (form.title.trim().length < 3) problems.title = t("admin.comms.ann.form.error.title");
  if (form.body.trim().length < 10) problems.body = t("admin.comms.ann.form.error.body");
  if (form.publishDate !== "" && !TIME_PATTERN.test(form.publishTime)) {
    problems.publishTime = t("admin.comms.ann.form.error.time");
  }
  if (form.expiryDate !== "" && !TIME_PATTERN.test(form.expiryTime)) {
    problems.expiryTime = t("admin.comms.ann.form.error.time");
  }
  if (form.scope === "targeted" && form.departmentId === "" && form.locationId === "") {
    problems.audience = t("admin.comms.ann.form.error.audience");
  }
  if (
    form.publishDate !== "" &&
    form.expiryDate !== "" &&
    TIME_PATTERN.test(form.publishTime) &&
    TIME_PATTERN.test(form.expiryTime) &&
    istWallClockToInstant(form.expiryDate, form.expiryTime) <=
      istWallClockToInstant(form.publishDate, form.publishTime)
  ) {
    problems.form = t("admin.comms.ann.form.error.window");
  }
  return problems;
}

function audienceOf(form: FormState): Audience {
  if (form.scope === "all") return { all: true };
  return {
    ...(form.departmentId !== "" ? { department_ids: [form.departmentId] } : {}),
    ...(form.locationId !== "" ? { location_ids: [form.locationId] } : {}),
  };
}

function instantOf(date: string, time: string): string | null {
  if (date === "" || !TIME_PATTERN.test(time)) return null;
  return istWallClockToInstant(date, time);
}

// -----------------------------------------------------------------------------

type ViewSlice = "live" | "archived";

export default function AnnouncementsPage() {
  const [params, setParams] = useSearchParams();
  const view: ViewSlice = params.get("view") === "archived" ? "archived" : "live";

  const [status, setStatus] = useState<AnnouncementStatus | "">("");
  const [kind, setKind] = useState<AnnouncementKind | "">("");
  const [priority, setPriority] = useState<AnnouncementPriority | "">("");
  const [search, setSearch] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);

  const { user } = useAuth();
  const actorProfileId = user?.id ?? null;
  const companyId = useDefaultCompanyId();
  const departments = useRefOptions("departments");
  const locations = useRefOptions("locations");

  const departmentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of departments.data ?? []) map.set(row.id, row.name);
    return map;
  }, [departments.data]);
  const locationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of locations.data ?? []) map.set(row.id, row.name);
    return map;
  }, [locations.data]);

  const filters = useMemo<AnnouncementFilters>(
    () => ({
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(kind !== "" ? { kinds: [kind] } : {}),
      ...(priority !== "" ? { priorities: [priority] } : {}),
      ...(pinnedOnly ? { pinnedOnly: true } : {}),
      ...(search.trim() !== "" ? { titleLike: search.trim() } : {}),
      ...(view === "archived" ? { archived: true } : {}),
    }),
    [status, kind, priority, pinnedOnly, search, view],
  );

  const list = useAnnouncements(filters);
  const total = useAnnouncementCount(filters);
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Tiles: four independent server counts over the SAME builder as the list.
  const publishedCount = useAnnouncementCount({ statuses: ["published"] });
  const scheduledCount = useAnnouncementCount({ statuses: ["scheduled"] });
  const draftCount = useAnnouncementCount({ statuses: ["draft"] });
  const ackCount = useAnnouncementCount({ statuses: ["published"], ackOnly: true });

  const create = useCreateAnnouncement((row) => {
    setSavedTitle(row.title);
    setSheetOpen(false);
  });
  const update = useUpdateAnnouncement((row) => {
    setSavedTitle(row.title);
    setSheetOpen(false);
  });
  const publish = usePublishAnnouncement();
  const archive = useArchiveAnnouncement();
  const remove = useDeleteAnnouncement();
  const restore = useRestoreAnnouncement();

  const problems = validate(form);
  const hasProblems = Object.keys(problems).length > 0;
  const pending = create.isPending || update.isPending;

  const setView = (next: ViewSlice) => {
    const p = new URLSearchParams(params);
    if (next === "live") p.delete("view");
    else p.set("view", next);
    setParams(p, { replace: true });
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSubmitted(false);
    setSavedTitle(null);
    setSheetOpen(true);
  };

  const openEdit = (row: Announcement) => {
    setEditing(row);
    setForm(formFromRow(row));
    setSubmitted(false);
    setSavedTitle(null);
    setSheetOpen(true);
  };

  const submit = () => {
    setSubmitted(true);
    if (hasProblems) return;
    const publishAt = instantOf(form.publishDate, form.publishTime);
    const expiresAt = instantOf(form.expiryDate, form.expiryTime);
    const draft = {
      title: form.title.trim(),
      bodyMarkdown: form.body.trim(),
      kind: form.kind,
      priority: form.priority,
      pinned: form.pinned,
      requiresAcknowledgement: form.requiresAck,
      publishAt,
      expiresAt,
      audience: audienceOf(form),
    };
    if (editing !== null) {
      update.save({ id: editing.id, ...draft }, t("admin.comms.ann.reason.edit"));
      return;
    }
    if (companyId === null) return;
    create.save(
      {
        companyId,
        status: publishAt !== null ? "scheduled" : "draft",
        ...draft,
      },
      t("admin.comms.ann.reason.create"),
    );
  };

  const anyFilter =
    status !== "" || kind !== "" || priority !== "" || pinnedOnly || search.trim() !== "";

  const clearAll = () => {
    setStatus("");
    setKind("");
    setPriority("");
    setPinnedOnly(false);
    setSearch("");
  };

  const serverMessage = editing !== null ? update.userMessage : create.userMessage;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Megaphone}
        title={t("admin.comms.ann.title")}
        subtitle={
          total.isSuccess
            ? t("admin.comms.ann.subtitle", { n: formatNumber(total.data) })
            : t("admin.comms.ann.subtitlePlain")
        }
        actions={
          <Button onClick={openCreate} disabled={companyId === null}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("admin.comms.ann.action.new")}
          </Button>
        }
      />

      {companyId === null ? (
        <div className="mb-4">
          <Notice tone="warning">{t("admin.comms.ann.noCompany")}</Notice>
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.comms.ann.kpi.published")}
          value={publishedCount.isSuccess ? formatNumber(publishedCount.data) : dash(null)}
          tone="success"
          hint={t("admin.comms.ann.kpi.publishedHint")}
        />
        <KpiTile
          label={t("admin.comms.ann.kpi.scheduled")}
          value={scheduledCount.isSuccess ? formatNumber(scheduledCount.data) : dash(null)}
          tone="info"
          hint={t("admin.comms.ann.kpi.scheduledHint")}
        />
        <KpiTile
          label={t("admin.comms.ann.kpi.drafts")}
          value={draftCount.isSuccess ? formatNumber(draftCount.data) : dash(null)}
          hint={t("admin.comms.ann.kpi.draftsHint")}
        />
        <KpiTile
          label={t("admin.comms.ann.kpi.needsAck")}
          value={ackCount.isSuccess ? formatNumber(ackCount.data) : dash(null)}
          tone={ackCount.data !== undefined && ackCount.data > 0 ? "warn" : "neutral"}
          hint={t("admin.comms.ann.kpi.needsAckHint")}
        />
      </section>

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.comms.ann.filter.status")}
          value={status}
          placeholder={t("admin.comms.ann.filter.anyStatus")}
          options={announcementStatusSchema.options.map((s) => ({
            value: s,
            label: STATUS_CHIP[s]?.label ?? s,
          }))}
          onChange={(v) => setStatus(v as AnnouncementStatus | "")}
        />
        <SelectField
          label={t("admin.comms.ann.filter.kind")}
          value={kind}
          placeholder={t("admin.comms.ann.filter.anyKind")}
          options={announcementKindSchema.options.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={(v) => setKind(v as AnnouncementKind | "")}
        />
        <SelectField
          label={t("admin.comms.ann.filter.priority")}
          value={priority}
          placeholder={t("admin.comms.ann.filter.anyPriority")}
          options={announcementPrioritySchema.options.map((p) => ({
            value: p,
            label: PRIORITY_LABEL[p],
          }))}
          onChange={(v) => setPriority(v as AnnouncementPriority | "")}
        />
        <TextField
          label={t("admin.comms.ann.filter.search")}
          value={search}
          onChange={setSearch}
          placeholder={t("admin.comms.ann.filter.searchPlaceholder")}
        />
        <div className="flex flex-wrap items-end gap-2 lg:col-span-4">
          <Button
            type="button"
            variant={pinnedOnly ? "default" : "outline"}
            aria-pressed={pinnedOnly}
            onClick={() => setPinnedOnly((v) => !v)}
          >
            <Pin className="mr-1.5 h-4 w-4" aria-hidden />
            {t("admin.comms.ann.filter.pinnedOnly")}
          </Button>
          <Button
            type="button"
            variant={view === "archived" ? "default" : "outline"}
            aria-pressed={view === "archived"}
            onClick={() => setView(view === "archived" ? "live" : "archived")}
          >
            {t("admin.comms.ann.filter.archived")}
          </Button>
          {anyFilter ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.comms.ann.filter.clear")}
            </Button>
          ) : null}
          <p className="ml-auto text-sm text-muted-foreground">
            {total.isSuccess
              ? t("admin.comms.ann.matching", { n: formatNumber(total.data) })
              : t("admin.comms.ann.matchingUnknown")}
          </p>
        </div>
      </div>

      {view === "archived" ? (
        <div className="mb-4">
          <Notice tone="info">{t("admin.comms.ann.archivedNotice")}</Notice>
        </div>
      ) : null}

      {savedTitle !== null ? (
        <div className="mb-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setSavedTitle(null)}>
                {t("admin.comms.ann.dismiss")}
              </Button>
            }
          >
            {t("admin.comms.ann.saved", { title: savedTitle })}
          </Notice>
        </div>
      ) : null}

      {publish.userMessage !== null ? (
        <div className="mb-4">
          <Notice tone="error">{publish.userMessage}</Notice>
        </div>
      ) : null}

      <StateBoundary
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        isEmpty={rows.length === 0}
        partialError={total.error}
        partialLabel={t("admin.comms.ann.partial.total")}
        empty={
          anyFilter || view === "archived" ? (
            <EmptyState
              icon={Bell}
              title={t("admin.comms.ann.empty.filtered.title")}
              hint={t("admin.comms.ann.empty.filtered.hint")}
              action={
                <Button variant="outline" onClick={clearAll}>
                  {t("admin.comms.ann.filter.clear")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Bell}
              title={t("admin.comms.ann.empty.title")}
              hint={t("admin.comms.ann.empty.hint")}
              action={
                <Button onClick={openCreate} disabled={companyId === null}>
                  {t("admin.comms.ann.action.new")}
                </Button>
              }
            />
          )
        }
        skeletonRows={4}
      >
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-base font-semibold">{row.title}</h2>
                    {row.pinned ? (
                      <Badge variant="outline">
                        <Pin className="mr-1 h-3 w-3" aria-hidden />
                        {t("admin.comms.ann.pinned")}
                      </Badge>
                    ) : null}
                    {row.requires_acknowledgement ? (
                      <Badge variant="warning">{t("admin.comms.ann.needsAck")}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {kindLabel(row.announcement_kind)} ·{" "}
                    {t("admin.comms.ann.audienceLabel", {
                      who: audienceSummary(row.audience, {
                        departments: departmentNames,
                        locations: locationNames,
                      }),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant={priorityVariant(row.priority)}>
                    {priorityLabel(row.priority)}
                  </Badge>
                  <StatusChip status={row.status} map={STATUS_CHIP} />
                </div>
              </div>

              <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                {row.body_markdown}
              </p>

              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="inline">{t("admin.comms.ann.field.publishAt")} </dt>
                  <dd className="inline">
                    {row.publish_at !== null ? fmtDateTime(row.publish_at) : dash(null)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("admin.comms.ann.field.expiresAt")} </dt>
                  <dd className="inline">
                    {row.expires_at !== null ? fmtDateTime(row.expires_at) : dash(null)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("admin.comms.ann.field.publishedAt")} </dt>
                  <dd className="inline">
                    {row.published_at !== null ? fmtDateTime(row.published_at) : dash(null)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("admin.comms.ann.field.views")} </dt>
                  <dd className="num inline">{formatNumber(row.view_count)}</dd>
                </div>
              </dl>

              {row.deleted_at !== null ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("admin.comms.ann.deletedAt", { at: fmtDateTime(row.deleted_at) })}
                  {row.deletion_reason !== null ? ` — ${row.deletion_reason}` : null}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {row.deleted_at !== null ? (
                  <ReasonActionButton
                    label={t("admin.comms.ann.action.restore")}
                    title={t("admin.comms.ann.restore.title", { title: row.title })}
                    description={t("admin.comms.ann.restore.description")}
                    minLength={15}
                    onConfirm={(reason) => restore.saveAsync({ id: row.id }, reason)}
                  />
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                      {t("admin.comms.ann.action.edit")}
                    </Button>
                    {row.status === "published" ? null : (
                      <ReasonActionButton
                        label={t("admin.comms.ann.action.publish")}
                        variant="default"
                        title={t("admin.comms.ann.publish.title", { title: row.title })}
                        description={t("admin.comms.ann.publish.description", {
                          who: audienceSummary(row.audience, {
                            departments: departmentNames,
                            locations: locationNames,
                          }),
                        })}
                        minLength={15}
                        disabled={actorProfileId === null}
                        disabledHint={t("admin.comms.ann.publish.noActor")}
                        onConfirm={(reason) =>
                          publish.saveAsync(
                            { id: row.id, actorProfileId: actorProfileId ?? "" },
                            reason,
                          )
                        }
                      />
                    )}
                    {row.status === "archived" ? null : (
                      <ReasonActionButton
                        label={t("admin.comms.ann.action.archive")}
                        title={t("admin.comms.ann.archive.title", { title: row.title })}
                        description={t("admin.comms.ann.archive.description")}
                        minLength={15}
                        onConfirm={(reason) => archive.saveAsync({ id: row.id }, reason)}
                      />
                    )}
                    <ReasonActionButton
                      label={t("admin.comms.ann.action.delete")}
                      variant="ghost"
                      title={t("admin.comms.ann.delete.title", { title: row.title })}
                      description={t("admin.comms.ann.delete.description")}
                      minLength={15}
                      onConfirm={(reason) => remove.saveAsync({ id: row.id }, reason)}
                    />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.ann.footnote")}</p>

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open && !pending) setSheetOpen(false);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {editing !== null
                ? t("admin.comms.ann.form.editTitle")
                : t("admin.comms.ann.form.createTitle")}
            </SheetTitle>
            <SheetDescription>{t("admin.comms.ann.form.description")}</SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            <TextField
              label={t("admin.comms.ann.form.title")}
              value={form.title}
              onChange={(v) => setForm((f) => ({ ...f, title: v }))}
              required
              {...(submitted && problems.title !== undefined ? { error: problems.title } : {})}
            />
            <TextAreaField
              label={t("admin.comms.ann.form.body")}
              value={form.body}
              onChange={(v) => setForm((f) => ({ ...f, body: v }))}
              rows={7}
              required
              hint={t("admin.comms.ann.form.bodyHint")}
              {...(submitted && problems.body !== undefined ? { error: problems.body } : {})}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label={t("admin.comms.ann.form.kind")}
                value={form.kind}
                options={announcementKindSchema.options.map((k) => ({
                  value: k,
                  label: KIND_LABEL[k],
                }))}
                onChange={(v) => setForm((f) => ({ ...f, kind: v as AnnouncementKind }))}
              />
              <SelectField
                label={t("admin.comms.ann.form.priority")}
                value={form.priority}
                options={announcementPrioritySchema.options.map((p) => ({
                  value: p,
                  label: PRIORITY_LABEL[p],
                }))}
                onChange={(v) => setForm((f) => ({ ...f, priority: v as AnnouncementPriority }))}
                hint={t("admin.comms.ann.form.priorityHint")}
              />
            </div>

            <SelectField
              label={t("admin.comms.ann.form.scope")}
              value={form.scope}
              options={[
                { value: "all", label: t("admin.comms.ann.form.scope.all") },
                { value: "targeted", label: t("admin.comms.ann.form.scope.targeted") },
              ]}
              onChange={(v) => setForm((f) => ({ ...f, scope: v as AudienceScope }))}
              hint={t("admin.comms.ann.form.scopeHint")}
              {...(submitted && problems.audience !== undefined
                ? { error: problems.audience }
                : {})}
            />
            {form.scope === "targeted" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label={t("admin.comms.ann.form.department")}
                  value={form.departmentId}
                  placeholder={t("admin.comms.ann.form.anyDepartment")}
                  options={(departments.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                  onChange={(v) => setForm((f) => ({ ...f, departmentId: v }))}
                />
                <SelectField
                  label={t("admin.comms.ann.form.location")}
                  value={form.locationId}
                  placeholder={t("admin.comms.ann.form.anyLocation")}
                  options={(locations.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                  onChange={(v) => setForm((f) => ({ ...f, locationId: v }))}
                />
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t("admin.comms.ann.form.publishDate")}
                type="date"
                value={form.publishDate}
                onChange={(v) => setForm((f) => ({ ...f, publishDate: v }))}
                min={nowIstDate()}
                hint={t("admin.comms.ann.form.publishDateHint")}
              />
              <TextField
                label={t("admin.comms.ann.form.publishTime")}
                value={form.publishTime}
                onChange={(v) => setForm((f) => ({ ...f, publishTime: v }))}
                placeholder="09:00"
                inputMode="numeric"
                {...(submitted && problems.publishTime !== undefined
                  ? { error: problems.publishTime }
                  : {})}
              />
              <TextField
                label={t("admin.comms.ann.form.expiryDate")}
                type="date"
                value={form.expiryDate}
                onChange={(v) => setForm((f) => ({ ...f, expiryDate: v }))}
                min={nowIstDate()}
                hint={t("admin.comms.ann.form.expiryDateHint")}
              />
              <TextField
                label={t("admin.comms.ann.form.expiryTime")}
                value={form.expiryTime}
                onChange={(v) => setForm((f) => ({ ...f, expiryTime: v }))}
                placeholder="18:00"
                inputMode="numeric"
                {...(submitted && problems.expiryTime !== undefined
                  ? { error: problems.expiryTime }
                  : {})}
              />
            </div>

            <CheckboxField
              label={t("admin.comms.ann.form.pinned")}
              checked={form.pinned}
              onChange={(v) => setForm((f) => ({ ...f, pinned: v }))}
              hint={t("admin.comms.ann.form.pinnedHint")}
            />
            <CheckboxField
              label={t("admin.comms.ann.form.requiresAck")}
              checked={form.requiresAck}
              onChange={(v) => setForm((f) => ({ ...f, requiresAck: v }))}
              hint={t("admin.comms.ann.form.requiresAckHint")}
            />

            {submitted && problems.form !== undefined ? (
              <Notice tone="error">{problems.form}</Notice>
            ) : null}
            {serverMessage !== null ? <Notice tone="error">{serverMessage}</Notice> : null}
            <Notice tone="info">{t("admin.comms.ann.form.publishNote")}</Notice>
          </div>

          <SheetFooter className="mt-6">
            <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={pending}>
              {t("admin.comms.ann.form.cancel")}
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? t("admin.comms.ann.form.saving") : t("admin.comms.ann.form.save")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
