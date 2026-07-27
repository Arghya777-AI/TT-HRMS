/**
 * §14 · /admin/comms/helpdesk — Help Desk. Tickets across every queue, with
 * service levels.
 *
 * THIS SCREEN HAS NO BACKEND, AND THAT IS THE FINDING.
 *
 * Probed live as the HR-admin persona:
 *
 *     GET /rest/v1/helpdesk_tickets?select=id
 *     → 404 {"code":"PGRST205",
 *            "message":"Could not find the table 'public.helpdesk_tickets'
 *                       in the schema cache",
 *            "hint":"Perhaps you meant the table 'public.request_types'"}
 *
 * and confirmed against the source: no migration in `supabase/migrations/`
 * creates a ticketing table — not `helpdesk_tickets`, not a ticket queue, not an
 * SLA clock for one. PostgREST's hint points at `request_types`, which is the
 * APPROVAL-chain catalogue (migration 029) and a different thing entirely: an
 * approval request is a decision on a form someone submitted, not a conversation
 * with a service level.
 *
 * What DOES exist, and is read live below, is the module's own entry in the
 * `feature_flags` register: `help_desk` — "HR ticketing module" — seeded
 * disabled with an expiry of 2027-04-01. So the honest screen is the register's
 * own words plus the name of the missing table, and NOTHING that looks like a
 * ticket list. A fabricated queue here would be the single most damaging thing
 * on the whole console: an HR admin would believe nobody had raised anything.
 *
 * The two service-level surfaces that ARE real live under §12 and are linked, so
 * an admin looking for "what is overdue" is not left at a dead end.
 *
 * @route /admin/comms/helpdesk
 */
import { Link } from "react-router-dom";
import { LifeBuoy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { useHelpdeskFlag } from "../hooks/useCommsAdmin";
import { HELPDESK_FLAG_KEY, HELPDESK_TICKETS_TABLE } from "../api/comms.api";

const FLAG_MAP = {
  on: { label: t("admin.comms.hd.flag.on"), tone: "success" as const },
  off: { label: t("admin.comms.hd.flag.off"), tone: "neutral" as const },
};

export default function HelpdeskPage() {
  const flag = useHelpdeskFlag();
  const row = flag.data ?? null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={t("admin.comms.hd.title")}
        subtitle={t("admin.comms.hd.subtitle")}
      />

      <div className="mb-6">
        <Notice tone="warning">
          {t("admin.comms.hd.gapNotice", { table: HELPDESK_TICKETS_TABLE })}
        </Notice>
      </div>

      <EmptyState
        icon={LifeBuoy}
        title={t("admin.comms.hd.empty.title")}
        hint={t("admin.comms.hd.empty.hint", { table: HELPDESK_TICKETS_TABLE })}
      />

      <section className="mt-8 rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold">{t("admin.comms.hd.flagTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("admin.comms.hd.flagHint")}</p>
          </div>
          <Badge variant="outline" className="font-mono">
            {HELPDESK_FLAG_KEY}
          </Badge>
        </div>
        <StateBoundary
          loading={flag.isPending}
          error={flag.error}
          onRetry={() => void flag.refetch()}
          isEmpty={row === null}
          empty={
            <EmptyState
              icon={LifeBuoy}
              title={t("admin.comms.hd.empty.flag.title")}
              hint={t("admin.comms.hd.empty.flag.hint", { key: HELPDESK_FLAG_KEY })}
            />
          }
          skeletonRows={1}
        >
          {row !== null ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.hd.field.name")}
                </dt>
                <dd className="mt-1 text-sm">{row.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.hd.field.state")}
                </dt>
                <dd className="mt-1">
                  <StatusChip status={row.is_enabled ? "on" : "off"} map={FLAG_MAP} />
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.hd.field.planned")}
                </dt>
                <dd className="mt-1 text-sm">
                  {row.expires_at !== null ? fmtDateTime(row.expires_at) : dash(null)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.hd.field.owner")}
                </dt>
                <dd className="mt-1 text-sm">{dash(row.owner)}</dd>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("admin.comms.hd.field.description")}
                </dt>
                <dd className="mt-1 text-sm text-muted-foreground">{dash(row.description)}</dd>
              </div>
            </dl>
          ) : null}
        </StateBoundary>
        <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.hd.flagNote")}</p>
      </section>

      <section className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="font-display text-lg font-semibold">{t("admin.comms.hd.insteadTitle")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.comms.hd.insteadHint")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/workflow/inbox">{t("admin.comms.hd.link.inbox")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/workflow/sla">{t("admin.comms.hd.link.sla")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/comms/announcements">{t("admin.comms.hd.link.announcements")}</Link>
          </Button>
        </div>
      </section>

      <div className="mt-6">
        <Notice tone="info">{t("admin.comms.hd.buildNote")}</Notice>
      </div>
    </div>
  );
}
