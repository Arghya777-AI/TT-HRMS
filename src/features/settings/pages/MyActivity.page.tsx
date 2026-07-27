/**
 * /me/activity — my own audit trail: every change to my record, who made it and
 * why, plus who read the record and how I signed in.
 *
 * THE SOURCE, AND WHY IT IS NOT `audit_log`. The natural answer to "show me my
 * audit trail" is `v_audit_trail_employee` (migration 037 §8). It is declared
 * `security_invoker = true` over `public.audit_log`, and `audit_log`'s only
 * SELECT policy is `audit_log__admin_read USING (app.is_admin())` (006). An
 * employee reading it gets zero rows for a reason that is NOT "nothing happened",
 * so this screen would be at its most misleading exactly when it looked emptiest.
 * The trail is therefore assembled from the four relations an employee genuinely
 * owns, each of which carries its own attribution:
 *
 *   1. `employee_change_requests` (`ecr__self_read`) — field changes with a real
 *      `old_value` → `new_value` pair, and `requested_by` to tell a self-edit from
 *      HR acting on my behalf.
 *   2. `employee_lifecycle_events` (`ele__scope_read`) — employment events, each
 *      with a mandatory `reason` (CHECK length ≥ 10, so "why" is never blank).
 *   3. `v_my_data_access` — the statutory transparency register: who unmasked,
 *      exported or reported on my record, their name, and the purpose they had to
 *      type first.
 *   4. `sessions_audit` (`sessions_audit__self_read`) — my own sign-in events.
 *
 * WHAT IS REUSED, NOT REBUILT. 1 and 2 come from the profile domain's
 * `useRecordHistory` / `useChangeRequests` — the same functions `/me/profile/history`
 * renders, so the two screens cannot disagree about the same change. 3 is
 * `useMyDataAccess`. 4 is `<SignInActivitySection>` (../signin), which is the whole
 * sign-in transparency surface — the plain-language trail, the four server counts
 * over `sessions_audit`, the session this browser holds, and the sentences saying
 * what is recorded, what is NOT recorded and why. It replaced the six-column grid
 * that used to sit in this tab: "login_failed · 203.0.113.7 · Mozilla/5.0 (…)" is a
 * dump of a row, not an explanation of it, and this screen's whole purpose is that
 * an employee can tell their own activity from someone else's. The same component
 * feeds the card on /me/settings/security, so the two cannot disagree either.
 * This screen is the one place all four sit together, with a server count for each
 * and a filter across them; the profile tab remains the record-changes view inside
 * the profile.
 *
 * The four KPI numbers are `count=exact` reads (`useMyActivityCounts`), not
 * `rows.length` — the row reads are capped at 100–200 rows and a tally of a
 * capped page is how a screen starts reporting "200" forever.
 *
 * @route /me/activity
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleDashed, Eye, History, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useChangeRequests, useMyDataAccess, useRecordHistory } from "@/features/profile/hooks/useProfile";
import { historyValueDisplay } from "@/features/profile/display";
import type { DataAccessEntry, HistoryActor } from "@/features/profile/api/history.api";
import { SignInActivitySection } from "../signin/SignInActivitySection";
import { useMyActivityCounts } from "../hooks/useMyActivity";

/** `public.approval_status`, as it appears on a change request I raised. */
const REQUEST_CHIP: Readonly<Record<string, StatusChipEntry>> = {
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

/**
 * Attribution at the granularity the data supports. `profiles` is self-read only
 * (`profiles__self_read`), so another actor's NAME is not resolvable from a change
 * request — the trail attributes by role and never invents a person.
 */
function actorLabel(actor: HistoryActor): string {
  switch (actor) {
    case "you":
      return t("meActivity.actor.you");
    case "hr_on_your_behalf":
      return t("meActivity.actor.hrForYou");
    case "hr":
      return t("meActivity.actor.hr");
    case "system":
      return t("meActivity.actor.system");
  }
}

/** '(not set)' for an absent jsonb value — never a blank cell (DR-04). */
function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return t("meActivity.record.notSet");
  return historyValueDisplay(value);
}

/** 'employee_bank_accounts' → 'Employee bank accounts'. Never a raw name (D-10). */
function humaniseTable(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type ActivityTab = "record" | "reads" | "signIns";

export default function MyActivityPage() {
  const [tab, setTab] = useState<ActivityTab>("record");
  const counts = useMyActivityCounts();
  const history = useRecordHistory();
  const requests = useChangeRequests();
  const reads = useMyDataAccess();

  const entries = history.data ?? [];
  const openRequests = (requests.data ?? []).filter((row) => row.applied_at === null);
  const summary = counts.data ?? null;

  const readColumns: DataGridColumn<DataAccessEntry>[] = [
    {
      key: "accessed_at",
      header: t("meActivity.reads.col.when"),
      width: "13rem",
      render: (row) => fmtDateTime(row.accessed_at),
    },
    {
      key: "accessed_by",
      header: t("meActivity.reads.col.who"),
      render: (row) => (
        <span>
          {row.accessed_by}
          {row.actor_role === null ? null : (
            <span className="text-muted-foreground"> · {humaniseTable(row.actor_role)}</span>
          )}
        </span>
      ),
    },
    {
      key: "entity_table",
      header: t("meActivity.reads.col.what"),
      render: (row) => (
        <span>
          {humaniseTable(row.entity_table)}
          {row.fields === null || row.fields.length === 0 ? null : (
            <span className="text-muted-foreground">
              {" · "}
              {t("meActivity.reads.fields", { count: row.fields.length })}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "access_kind",
      header: t("meActivity.reads.col.kind"),
      hideBelow: "md",
      render: (row) => (
        <span>
          {humaniseTable(row.access_kind)}
          <span className="num text-muted-foreground">
            {" · "}
            {t("meActivity.reads.records", { count: formatNumber(row.record_count) })}
          </span>
        </span>
      ),
    },
    {
      key: "purpose",
      header: t("meActivity.reads.col.purpose"),
      hideBelow: "lg",
      render: (row) => dash(row.purpose ?? t("meActivity.reads.noPurpose")),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("meActivity.title")}
        subtitle={t("meActivity.subtitle")}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/me/settings/security">
              <KeyRound className="mr-2 h-4 w-4" aria-hidden />
              {t("meActivity.signIns.action")}
            </Link>
          </Button>
        }
      />

      <Notice tone="info" className="mb-4">
        {t("meActivity.source")}
      </Notice>

      {/* The four numbers, each counted by Postgres over my own rows. */}
      <StateBoundary
        loading={counts.isPending}
        error={counts.error}
        onRetry={() => void counts.refetch()}
        skeletonRows={1}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t("meActivity.kpi.changes")}
            value={formatNumber(summary?.changeRequests ?? 0)}
            hint={t("meActivity.kpi.hint")}
          />
          <KpiTile
            label={t("meActivity.kpi.events")}
            value={formatNumber(summary?.lifecycleEvents ?? 0)}
            hint={t("meActivity.kpi.hint")}
          />
          <KpiTile
            label={t("meActivity.kpi.reads")}
            value={formatNumber(summary?.dataAccesses ?? 0)}
            hint={t("meActivity.kpi.hint")}
          />
          <KpiTile
            label={t("meActivity.kpi.signIns")}
            value={formatNumber(summary?.signInEvents ?? 0)}
            hint={t("meActivity.kpi.hint")}
          />
        </div>
      </StateBoundary>

      <Tabs
        className="mt-6"
        value={tab}
        onValueChange={(value) => setTab(value as ActivityTab)}
      >
        <TabsList aria-label={t("meActivity.tabs.label")} className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="record">{t("meActivity.tab.record")}</TabsTrigger>
          <TabsTrigger value="reads">{t("meActivity.tab.reads")}</TabsTrigger>
          <TabsTrigger value="signIns">{t("meActivity.tab.signIns")}</TabsTrigger>
        </TabsList>

        {/* ── 1 + 2. Changes to my record ─────────────────────────────────── */}
        <TabsContent value="record" className="space-y-4">
          {openRequests.length === 0 ? null : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CircleDashed className="h-4 w-4" aria-hidden />
                  {t("meActivity.open.title")}
                </CardTitle>
                <CardDescription>{t("meActivity.open.hint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {openRequests.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{row.field_label}</p>
                        <p className="num text-xs text-muted-foreground">
                          {valueText(row.old_value)} → {valueText(row.new_value)}
                          {" · "}
                          {fmtDateTime(row.requested_at)}
                        </p>
                        {row.decision_comment === null ? null : (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("meActivity.open.decision", { comment: row.decision_comment })}
                          </p>
                        )}
                      </div>
                      <StatusChip status={row.status} map={REQUEST_CHIP} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <StateBoundary
            loading={history.isPending}
            error={history.error}
            onRetry={() => void history.refetch()}
            isEmpty={!history.isPending && entries.length === 0}
            empty={
              <EmptyState
                icon={History}
                title={t("meActivity.record.empty.title")}
                hint={t("meActivity.record.empty.hint")}
              />
            }
            partialError={requests.error}
            partialLabel={t("meActivity.partial.open")}
            skeletonRows={5}
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <History className="h-4 w-4" aria-hidden />
                  {t("meActivity.record.title")}
                </CardTitle>
                <CardDescription>{t("meActivity.record.hint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="relative space-y-0 border-l pl-5">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className={cn("relative py-3", entry.reversed && "opacity-60")}
                    >
                      <span
                        className="absolute -left-[1.4rem] top-4 size-2.5 rounded-full border-2 border-background bg-primary"
                        aria-hidden
                      />
                      <p className="text-sm font-medium">
                        {entry.what}
                        {entry.reversed ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {t("meActivity.record.reversed")}
                          </span>
                        ) : null}
                      </p>
                      <p className="num mt-0.5 text-xs text-muted-foreground">
                        {valueText(entry.from)} → {valueText(entry.to)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {fmtDateTime(entry.occurredAt)} · {actorLabel(entry.actor)}
                        {entry.reason === null
                          ? null
                          : ` · ${t("meActivity.record.because", { reason: entry.reason })}`}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </StateBoundary>
        </TabsContent>

        {/* ── 3. Who read my details ──────────────────────────────────────── */}
        <TabsContent value="reads">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye className="h-4 w-4" aria-hidden />
                {t("meActivity.reads.title")}
              </CardTitle>
              <CardDescription>{t("meActivity.reads.hint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <StateBoundary
                loading={reads.isPending}
                error={reads.error}
                onRetry={() => void reads.refetch()}
                skeletonRows={4}
              >
                <DataGrid
                  columns={readColumns}
                  rows={reads.data ?? []}
                  rowKey={(row) => row.id}
                  emptyState={
                    <EmptyState
                      icon={Eye}
                      title={t("meActivity.reads.empty.title")}
                      hint={t("meActivity.reads.empty.hint")}
                    />
                  }
                />
              </StateBoundary>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── 4. Sign-ins ─────────────────────────────────────────────────── */}
        <TabsContent value="signIns">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-4 w-4" aria-hidden />
                {t("meActivity.signIns.title")}
              </CardTitle>
              <CardDescription>{t("meActivity.signIns.hint")}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Owns its own reads, counts and state boundaries — see ../signin. */}
              <SignInActivitySection />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
