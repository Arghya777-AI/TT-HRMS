/**
 * E-10.5 · /me/apply/travel — "Trip request with advance and estimated cost."
 *
 * The brief was to raise this through `public.create_approval_request` with the
 * `TRAVEL_REQUISITION` type. That call cannot succeed against the deployed
 * schema, for two reasons that are facts rather than opinions — and the screen
 * establishes the second by READING rather than asserting:
 *
 *  1. NO DETAIL ROW TO POINT AT. The type's `detail_table` is
 *     `travel_requisitions`, and no migration creates it. The name appears twice
 *     as a STRING only — in `ck_request_types__detail_table` (029 §1) and in the
 *     045 §2 seed row — and migration 024's own header says it outright: "No FK
 *     on reimbursement_claims.travel_requisition_id: no travel_requisitions
 *     table exists anywhere in the §13 plan." `approval_requests.detail_id` is
 *     NOT NULL, so the request needs a row that has nowhere to live.
 *  2. NO APPROVAL CHAIN. 045 §3 seeds chains for eleven of the eighteen request
 *     types; `TRAVEL_REQUISITION` is not one, and its
 *     `default_approval_chain_id` stays NULL, so `create_approval_request` raises
 *     `no approval chain matches request type TRAVEL_REQUISITION`. The routing
 *     card below reads `approval_chains` for this type and shows the empty
 *     result — that is the proof.
 *
 * THREE THINGS THIS SCREEN ALSO REFUSES TO INVENT, all named in
 * spec-employee §5: `travel_policies.max_advance` (no such table), the per-grade
 * estimated-cost cap (no table in the schema holds one), and the L2-above-₹10,000
 * escalation (an approval-chain band, and this type has no chain to band).
 *
 * What it shows instead is real, self-scoped and the thing an employee actually
 * needs: the route travel MONEY takes today. `ck_rc__claim_type` has a `travel`
 * head, `reimbursement_claims` accepts a self-insert, and `/me/apply/claim` is
 * live — so the trip is reimbursed even though the requisition cannot be filed.
 * The claim ledger below also renders `travel_requisition_id`, which is always
 * empty, and `claim_kind` — whose `'travel_requisition_settlement'` value is
 * unreachable because `ck_rc__settlement_link` demands a requisition id.
 *
 * @route /me/apply/travel
 */
import { Link } from "react-router-dom";
import { Plane, Receipt, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { dash } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { REQUEST_CODE_TRAVEL, type TravelClaim } from "../api/apply-forms.api";
import { useMyOpenRequestsOfType, useRequestRouting, useRequestTypeByCode } from "../hooks/useApply";
import { useMyTravelClaims } from "../hooks/useApplyForms";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/**
 * `public.approval_status` as it applies to the CLAIM row. Same vocabulary and
 * same words as `/me/apply/claim`, so the two screens cannot describe one claim
 * differently.
 */
const CLAIM_STATUS_MAP: Record<string, StatusChipEntry> = {
  draft: { label: t("apply.claim.status.draft"), tone: "neutral" },
  pending: { label: t("apply.claim.status.pending"), tone: "warn" },
  in_progress: { label: t("apply.claim.status.pending"), tone: "warn" },
  approved: { label: t("apply.claim.status.approved"), tone: "success" },
  rejected: { label: t("apply.claim.status.rejected"), tone: "danger" },
  cancelled: { label: t("apply.claim.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("apply.claim.status.cancelled"), tone: "neutral" },
  applied: { label: t("apply.claim.status.paid"), tone: "success" },
};

/** `ck_rc__claim_kind`'s two values, in the words a venue employee uses. */
const CLAIM_KIND_LABEL: Readonly<Record<string, string>> = {
  local_claim: t("apply.travel.kind.local"),
  travel_requisition_settlement: t("apply.travel.kind.settlement"),
};

export default function TravelRequisitionPage() {
  const type = useRequestTypeByCode(REQUEST_CODE_TRAVEL);
  const routing = useRequestRouting(type.data?.id);
  const open = useMyOpenRequestsOfType(type.data?.id);
  const claims = useMyTravelClaims();

  const claimColumns: DataGridColumn<TravelClaim>[] = [
    {
      key: "claim_number",
      header: t("apply.claim.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.claim_number}</span>,
    },
    {
      key: "claim_kind",
      header: t("apply.travel.col.kind"),
      render: (row) => CLAIM_KIND_LABEL[row.claim_kind] ?? row.claim_kind,
    },
    {
      key: "period_from",
      header: t("apply.travel.col.travelled"),
      width: "9rem",
      hideBelow: "md",
      sortable: true,
      render: (row) => fmtCivilDate(row.period_from),
    },
    {
      key: "event_reference",
      header: t("apply.claim.col.event"),
      hideBelow: "lg",
      render: (row) => dash(row.event_reference),
    },
    {
      key: "travel_requisition_id",
      header: t("apply.travel.col.requisition"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => dash(row.travel_requisition_id),
    },
    {
      key: "total_claimed_paise",
      header: t("apply.claim.col.claimed"),
      align: "right",
      width: "8rem",
      render: (row) => <Money paise={row.total_claimed_paise} />,
    },
    {
      key: "total_approved_paise",
      header: t("apply.claim.col.approved"),
      align: "right",
      width: "8rem",
      hideBelow: "lg",
      render: (row) =>
        row.total_approved_paise === null ? dash(null) : <Money paise={row.total_approved_paise} />,
    },
    {
      key: "status",
      header: t("apply.claim.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={CLAIM_STATUS_MAP} />,
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Plane}
        title={t("apply.travel.title")}
        subtitle={t("apply.travel.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">{t("apply.back")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        {/* ── The blocking facts, named ───────────────────────────────────── */}
        <Notice tone="error">
          <p className="font-medium">{t("apply.travel.gap.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("apply.travel.gap.table")}</li>
            <li>{t("apply.travel.gap.chain")}</li>
          </ul>
        </Notice>

        {/* ── The route travel money DOES take today ──────────────────────── */}
        <EmptyState
          icon={Wallet}
          title={t("apply.travel.alt.title")}
          hint={t("apply.travel.alt.hint")}
          action={
            <Button asChild>
              <Link to="/me/apply/claim">{t("apply.travel.alt.cta")}</Link>
            </Button>
          }
        />

        {/* ── What the workflow engine has configured for this type ───────── */}
        <section aria-labelledby="travel-routing">
          <h2 id="travel-routing" className="mb-3 font-display text-lg font-semibold">
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
                    {type.data.escalation_hours !== null ? (
                      <span>{t("apply.type.escalates", { hours: type.data.escalation_hours })}</span>
                    ) : null}
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
                  missingChainMessage={t("apply.travel.gap.chain")}
                />
              </div>
            )}
          </StateBoundary>
        </section>

        {/* ── Caps and advances the schema does not hold ──────────────────── */}
        <Notice tone="info">
          <p className="font-medium">{t("apply.travel.caps.title")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("apply.travel.caps.policy")}</li>
            <li>{t("apply.travel.caps.grade")}</li>
            <li>{t("apply.travel.caps.advance")}</li>
          </ul>
        </Notice>

        {/* ── My travel spend, from the table that does exist ─────────────── */}
        <section aria-labelledby="travel-claims">
          <h2 id="travel-claims" className="font-display text-lg font-semibold">
            {t("apply.travel.ledger.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.travel.ledger.hint")}</p>
          <StateBoundary
            loading={claims.isLoading}
            error={claims.error ?? undefined}
            onRetry={() => void claims.refetch()}
          >
            <DataGrid
              columns={claimColumns}
              rows={claims.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={Receipt}
                  title={t("apply.travel.ledger.empty.title")}
                  hint={t("apply.travel.ledger.empty.hint")}
                  action={
                    <Button asChild>
                      <Link to="/me/apply/claim">{t("apply.travel.alt.cta")}</Link>
                    </Button>
                  }
                />
              }
            />
          </StateBoundary>
        </section>

        {/* ── Anything of this type already in flight ─────────────────────── */}
        <section aria-labelledby="travel-open">
          <h2 id="travel-open" className="mb-3 font-display text-lg font-semibold">
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
              emptyTitle={t("apply.travel.mine.empty.title")}
              emptyHint={t("apply.travel.mine.empty.hint")}
            />
          </StateBoundary>
        </section>

        {/* ── What a migration would have to add ──────────────────────────── */}
        <section aria-labelledby="travel-when-ready">
          <h2 id="travel-when-ready" className="font-display text-lg font-semibold">
            {t("apply.travel.ready.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.travel.ready.hint")}</p>
          <ol className="list-decimal space-y-1.5 rounded-lg border bg-card p-4 pl-9 text-sm">
            <li>{t("apply.travel.ready.item1")}</li>
            <li>{t("apply.travel.ready.item2")}</li>
            <li>{t("apply.travel.ready.item3")}</li>
            <li>{t("apply.travel.ready.item4")}</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
