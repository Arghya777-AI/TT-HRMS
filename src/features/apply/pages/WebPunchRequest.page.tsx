/**
 * E-10.1 · /me/apply/web-punch — "Punch from outside the gate when you're
 * entitled to."
 *
 * THIS SCREEN IS A REQUEST, NOT A PUNCH, and today it is a request the deployed
 * backend cannot accept. Both reasons are read from the server rather than
 * asserted in prose:
 *
 *  1. `request_types.code = 'WEB_LOGIN'` exists (046 §2) and names
 *     `detail_table = 'web_punch_requests'` — a table NO migration creates. It
 *     appears twice as a string only: in `ck_request_types__detail_table` (029)
 *     and in that seed row. `approval_requests.detail_id` is NOT NULL, so a
 *     request needs a detail row that has nowhere to live.
 *  2. 046 §3 seeds no approval chain for `WEB_LOGIN`, so
 *     `create_approval_request` would raise `no approval chain matches request
 *     type WEB_LOGIN`. `RequestRoutingCard` proves that by reading
 *     `approval_chains` for this type and finding it empty.
 *
 * What the screen CAN answer honestly, and does, is the question an employee
 * actually has: am I allowed to punch from outside the gate at all? Two
 * server-owned switches decide it — `employees.allow_web_punch` (008) and
 * `attendance_policies.allow_web_punch` (014) — and both are shown as they are,
 * with the regularization window from the same policy row as the route that IS
 * live today.
 *
 * @route /me/apply/web-punch
 */
import { Link } from "react-router-dom";
import { ClipboardList, ScanFace, ShieldCheck, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { dash } from "@/lib/format";
import { REQUEST_CODE_WEB_PUNCH } from "../api/apply-requests.api";
import {
  useMyOpenRequestsOfType,
  useRequestRouting,
  useRequestTypeByCode,
  useWebPunchEntitlement,
} from "../hooks/useApply";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/** One server switch, rendered as what it is: a boolean somebody set. */
function SwitchRow({
  label,
  on,
  hint,
}: {
  label: string;
  on: boolean | null;
  hint: string;
}) {
  const Icon = on === true ? ShieldCheck : ShieldX;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon
        className={on === true ? "mt-0.5 h-4 w-4 shrink-0 text-success" : "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Badge variant={on === true ? "success" : "neutral"}>
        {on === null
          ? t("apply.webpunch.switch.unknown")
          : on
            ? t("apply.webpunch.switch.on")
            : t("apply.webpunch.switch.off")}
      </Badge>
    </li>
  );
}

export default function WebPunchRequestPage() {
  const type = useRequestTypeByCode(REQUEST_CODE_WEB_PUNCH);
  const routing = useRequestRouting(type.data?.id);
  const entitlement = useWebPunchEntitlement();
  const open = useMyOpenRequestsOfType(type.data?.id);

  const policy = entitlement.data?.policy ?? null;

  return (
    <div>
      <PageHeader
        icon={ScanFace}
        title={t("apply.webpunch.title")}
        subtitle={t("apply.webpunch.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">{t("apply.back")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ── The blocking facts, named ───────────────────────────────────── */}
        <Notice tone="error">
          <p className="font-medium">{t("apply.webpunch.gap.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("apply.webpunch.gap.table")}</li>
            <li>{t("apply.webpunch.gap.chain")}</li>
          </ul>
        </Notice>

        {/* ── Am I entitled at all? ───────────────────────────────────────── */}
        <section aria-labelledby="webpunch-entitlement">
          <h2 id="webpunch-entitlement" className="mb-3 font-display text-lg font-semibold">
            {t("apply.webpunch.entitlement.title")}
          </h2>
          <StateBoundary
            loading={entitlement.isLoading}
            error={entitlement.error ?? undefined}
            onRetry={() => void entitlement.refetch()}
            isEmpty={entitlement.data === null && !entitlement.isLoading}
            empty={
              <EmptyState
                icon={ScanFace}
                title={t("apply.webpunch.entitlement.empty.title")}
                hint={t("apply.webpunch.entitlement.empty.hint")}
              />
            }
            skeletonRows={2}
          >
            <div className="rounded-lg border bg-card p-4">
              <ul className="divide-y">
                <SwitchRow
                  label={t("apply.webpunch.switch.employee")}
                  on={entitlement.data?.allowedForMe ?? null}
                  hint={t("apply.webpunch.switch.employee.hint")}
                />
                <SwitchRow
                  label={t("apply.webpunch.switch.policy", {
                    name: policy === null ? dash(null) : policy.name,
                  })}
                  on={policy === null ? null : policy.allow_web_punch}
                  hint={t("apply.webpunch.switch.policy.hint")}
                />
                <SwitchRow
                  label={t("apply.webpunch.switch.excluded")}
                  on={
                    entitlement.data === undefined || entitlement.data === null
                      ? null
                      : !entitlement.data.excludedFromAttendance
                  }
                  hint={t("apply.webpunch.switch.excluded.hint")}
                />
              </ul>

              {policy !== null ? (
                <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">
                  {t("apply.webpunch.policyFacts", {
                    code: policy.code,
                    days: policy.regularization_window_days,
                    max: policy.max_regularizations_per_month,
                  })}
                </p>
              ) : null}
            </div>
          </StateBoundary>
        </section>

        {/* ── What the workflow engine has configured for this type ───────── */}
        <section aria-labelledby="webpunch-routing">
          <h2 id="webpunch-routing" className="mb-3 font-display text-lg font-semibold">
            {t("apply.routing.section")}
          </h2>
          <StateBoundary
            loading={type.isLoading || routing.isLoading}
            error={type.error ?? routing.error ?? undefined}
            onRetry={() => {
              void type.refetch();
              void routing.refetch();
            }}
            skeletonRows={2}
          >
            {type.data === null ? (
              <Notice tone="warning">{t("apply.type.missing")}</Notice>
            ) : (
              <div className="space-y-3">
                {type.data !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{type.data.name}</Badge>
                    <span>{t("apply.tile.sla", { hours: type.data.sla_hours })}</span>
                    <span>
                      {type.data.allows_withdrawal
                        ? t("apply.type.withdrawable")
                        : t("apply.type.notWithdrawable")}
                    </span>
                    <span>{t("apply.type.detailTable", { table: type.data.detail_table })}</span>
                  </div>
                ) : null}
                <RequestRoutingCard
                  routing={routing.data}
                  missingChainMessage={t("apply.webpunch.gap.chain")}
                />
              </div>
            )}
          </StateBoundary>
        </section>

        {/* ── The route that IS live today ────────────────────────────────── */}
        <EmptyState
          icon={ClipboardList}
          title={t("apply.webpunch.alt.title")}
          hint={
            policy === null
              ? t("apply.webpunch.alt.hint")
              : t("apply.webpunch.alt.hintDays", { days: policy.regularization_window_days })
          }
          action={
            <Button asChild>
              <Link to="/me/regularizations/new">{t("apply.webpunch.alt.cta")}</Link>
            </Button>
          }
        />

        {/* ── Anything of this type already in flight ─────────────────────── */}
        <section aria-labelledby="webpunch-open">
          <h2 id="webpunch-open" className="mb-3 font-display text-lg font-semibold">
            {t("apply.mine.title")}
          </h2>
          <StateBoundary
            loading={open.isLoading}
            error={open.error ?? undefined}
            onRetry={() => void open.refetch()}
          >
            <OpenRequestsGrid
              rows={open.data?.rows ?? []}
              approvers={open.data?.approvers ?? {}}
              emptyTitle={t("apply.webpunch.mine.empty.title")}
              emptyHint={t("apply.webpunch.mine.empty.hint")}
            />
          </StateBoundary>
        </section>
      </div>
    </div>
  );
}
