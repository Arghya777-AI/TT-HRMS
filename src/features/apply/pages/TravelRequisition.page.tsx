/**
 * E-10.5 · /me/apply/travel — trip request with an estimated cost and an advance.
 *
 * ── WHAT THIS PAGE USED TO SAY, AND WHY IT NO LONGER SAYS IT ─────────────────
 *
 * For most of its life this screen refused to offer a form, and it was right to.
 * `request_types.TRAVEL_REQUISITION` named a detail table `travel_requisitions`
 * that no migration created — the name existed twice as a STRING, in
 * `ck_request_types__detail_table` and in the 045 seed row, and nowhere as a
 * table — and `approval_requests.detail_id` is NOT NULL, so the request needed a
 * row with nowhere to live. It also had no approval chain: 045 seeded chains for
 * eleven of eighteen types and this was not one, so `create_approval_request`
 * raised `no approval chain matches request type TRAVEL_REQUISITION`.
 *
 * Migration 041100 created the table and seeded `AC-TRAVEL`, so both facts have
 * changed and the form below is real. The routing card still READS
 * `approval_chains` for this type rather than describing the route in prose —
 * that is what proves the chain is there, and it is also what will show it
 * disappearing if anyone deactivates it.
 *
 * ── STILL NOT INVENTED ───────────────────────────────────────────────────────
 *
 * `travel_policies.max_advance` (no such table), the per-grade estimated-cost cap
 * (no table in the schema holds one), and the L2-above-₹10,000 escalation (an
 * approval-chain band, and AC-TRAVEL is deliberately unbanded). A limit shown
 * here that no table enforces is a limit that is not a limit.
 *
 * ── THE MONEY IS STILL A SEPARATE STEP ───────────────────────────────────────
 *
 * An approved requisition is permission to travel, not a payment. The spend is
 * claimed afterwards through /me/apply/claim, and now that
 * `reimbursement_claims.travel_requisition_id` finally has a row to point at,
 * `claim_kind = 'travel_requisition_settlement'` — which
 * `ck_rc__settlement_link` made unreachable while the table was missing — is
 * reachable. The ledger below shows both columns.
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
import { useState } from "react";
import { t } from "@/shared/i18n/en";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mutationUserMessage } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import { rupeesToPaise } from "../api/claim-submit.api";
import { useSubmitTravelRequisition } from "../hooks/useApply";
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

  const trToday = nowIstDate();
  const [fromLoc, setFromLoc] = useState("");
  const [toLoc, setToLoc] = useState("");
  const [fromDate, setFromDate] = useState<string>(trToday);
  const [toDate, setToDate] = useState<string>(trToday);
  const [purpose, setPurpose] = useState("");
  const [cost, setCost] = useState("");
  const [advance, setAdvance] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const sendTr = useSubmitTravelRequisition();

  const trBlockers: string[] = [];
  if (fromLoc.trim() === "" || toLoc.trim() === "") trBlockers.push(t("apply.travel.blocked.where"));
  if (toDate < fromDate) trBlockers.push(t("apply.travel.blocked.range"));
  if (purpose.trim().length < 10) trBlockers.push(t("apply.travel.blocked.purpose"));
  if (cost.trim() !== "" && rupeesToPaise(cost) === null) trBlockers.push(t("apply.travel.blocked.cost"));
  if (advance.trim() !== "" && rupeesToPaise(advance) === null) trBlockers.push(t("apply.travel.blocked.cost"));

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
        {/*
          The gap notice here said the requisition table did not exist and no
          chain was configured. Migration 041100 created `travel_requisitions`
          and seeded AC-TRAVEL — and gave `reimbursement_claims
          .travel_requisition_id` something to point at, so a settlement claim
          against a trip is finally possible.
        */}
        {sent !== null ? <Notice tone="success">{t("apply.travel.done")}</Notice> : null}

        <section className="rounded-lg border bg-card p-4" aria-labelledby="tr-form">
          <h2 id="tr-form" className="font-display text-lg font-semibold">
            {t("apply.travel.form.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("apply.travel.form.hint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tr-from">{t("apply.travel.field.from")}</Label>
              <Input id="tr-from" className="mt-1.5 h-11" value={fromLoc}
                onChange={(e) => setFromLoc(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="tr-to">{t("apply.travel.field.to")}</Label>
              <Input id="tr-to" className="mt-1.5 h-11" value={toLoc}
                onChange={(e) => setToLoc(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="tr-fd">{t("apply.travel.field.fromDate")}</Label>
              <Input id="tr-fd" type="date" className="mt-1.5 h-11" value={fromDate}
                onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="tr-td">{t("apply.travel.field.toDate")}</Label>
              <Input id="tr-td" type="date" min={fromDate} className="mt-1.5 h-11" value={toDate}
                onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="tr-cost">{t("apply.travel.field.cost")}</Label>
              <Input id="tr-cost" inputMode="decimal" className="mt-1.5 h-11" value={cost}
                onChange={(e) => setCost(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="tr-adv">{t("apply.travel.field.advance")}</Label>
              <Input id="tr-adv" inputMode="decimal" className="mt-1.5 h-11" value={advance}
                onChange={(e) => setAdvance(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">{t("apply.travel.field.advance.hint")}</p>
            </div>
          </div>

          <div className="mt-3">
            <Label htmlFor="tr-purpose">{t("apply.travel.field.purpose")}</Label>
            <textarea id="tr-purpose" rows={3} maxLength={500} value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>

          {sendTr.isError ? (
            <div className="mt-3"><Notice tone="error">{mutationUserMessage(sendTr.error)}</Notice></div>
          ) : null}
          {trBlockers.length > 0 ? (
            <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <p className="font-medium">{t("apply.travel.blocked.title")}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {trBlockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : null}

          <Button className="mt-4 w-full" disabled={trBlockers.length > 0 || sendTr.isPending}
            onClick={() => {
              if (trBlockers.length > 0) return;
              sendTr.mutate(
                { fromLocation: fromLoc, toLocation: toLoc, fromDate, toDate, purpose,
                  estimatedCostRupees: cost, advanceRupees: advance },
                { onSuccess: (r) => { setSent(r.requestId); setPurpose(""); } },
              );
            }}
          >
            {sendTr.isPending ? t("apply.travel.sending") : t("apply.travel.send")}
          </Button>
        </section>

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
