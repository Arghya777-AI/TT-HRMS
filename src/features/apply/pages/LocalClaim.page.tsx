/**
 * E-10.2 · /me/apply/claim — "Expense claim with receipts and per-grade caps."
 *
 * The one request of the four E-10 screens the deployed backend can actually
 * accept, and the reason it can is written down in `claim-submit.api.ts`:
 * `reimbursement_claims` exists with a self-insert policy, its claim number is
 * minted by a trigger, and `LOCAL_CLAIM` is one of the eleven request types 046
 * §3 gives an approval chain.
 *
 * THREE THINGS THIS SCREEN REFUSES TO INVENT:
 *
 *  * PER-GRADE CAPS. The manifest hint asks for them; no table in the schema
 *    holds one. There is no `claim_caps`, no per-grade limit column, and
 *    `claim_lines.expense_head` is free text. The only server-side money
 *    thresholds that exist are the approval-chain amount bands (₹10,000), and
 *    those are shown for what they are — routing, not entitlement.
 *  * THE TOTAL. `reimbursement_claims.total_claimed_paise` is not maintained
 *    from `claim_lines` by any trigger, so a multi-line claim would need the
 *    browser to add the lines up. This screen therefore submits ONE line
 *    carrying the ONE figure the employee typed; the claim total and the line
 *    amount are the same server-stored integer, not a computed pair.
 *  * THE OUTCOME. `act_on_approval` never writes back to a detail table, so an
 *    approved claim's own `status` stays `pending` and `total_approved_paise`
 *    stays NULL until Finance edits the row. The decision of record is the
 *    approval request, which is why "In flight" below reads
 *    `approval_requests` and the claim list shows the claim's own state
 *    separately instead of pretending they are one thing.
 *
 * @route /me/apply/claim
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Paperclip, Receipt, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { dash } from "@/lib/format";
import { fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { mutationUserMessage } from "@/shared/api/query";
import { REQUEST_CODE_LOCAL_CLAIM } from "../api/apply-requests.api";
import {
  claimTypeValues,
  rupeesToPaise,
  type ClaimRow,
  type ClaimType,
  type SubmittedClaim,
} from "../api/claim-submit.api";
import {
  useMyClaims,
  useMyOpenRequestsOfType,
  useRequestRouting,
  useRequestTypeByCode,
  useSubmitLocalClaim,
} from "../hooks/useApply";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/** `ck_rc__claim_type`'s nine values, in the words a venue employee uses. */
const CLAIM_TYPE_LABEL: Readonly<Record<ClaimType, string>> = {
  local_conveyance: t("apply.claim.type.localConveyance"),
  travel: t("apply.claim.type.travel"),
  food: t("apply.claim.type.food"),
  medical: t("apply.claim.type.medical"),
  telephone: t("apply.claim.type.telephone"),
  uniform: t("apply.claim.type.uniform"),
  fuel: t("apply.claim.type.fuel"),
  guest_hospitality: t("apply.claim.type.guestHospitality"),
  misc: t("apply.claim.type.misc"),
};

/** `public.approval_status` as it applies to the CLAIM row, not the request. */
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

const MIN_DESCRIPTION = 10;

function isClaimType(value: string): value is ClaimType {
  return (claimTypeValues as readonly string[]).includes(value);
}

export default function LocalClaimPage() {
  const today = nowIstDate();
  const type = useRequestTypeByCode(REQUEST_CODE_LOCAL_CLAIM);
  const routing = useRequestRouting(type.data?.id);
  const open = useMyOpenRequestsOfType(type.data?.id);
  const claims = useMyClaims();
  const submit = useSubmitLocalClaim();

  const [claimType, setClaimType] = useState<ClaimType>("local_conveyance");
  const [periodFrom, setPeriodFrom] = useState<string>(today);
  const [periodTo, setPeriodTo] = useState<string>(today);
  const [amountRupees, setAmountRupees] = useState("");
  const [description, setDescription] = useState("");
  const [eventReference, setEventReference] = useState("");
  const [submitted, setSubmitted] = useState<SubmittedClaim | null>(null);

  const paise = amountRupees.trim() === "" ? null : rupeesToPaise(amountRupees);
  const amountInvalid = amountRupees.trim() !== "" && (paise === null || paise <= 0);
  const rangeInvalid = periodTo < periodFrom;
  const futureDated = periodFrom > today || periodTo > today;
  const descriptionTooShort = description.trim().length < MIN_DESCRIPTION;
  const receiptRequired = type.data?.requires_attachment ?? false;
  // No chain, no request: `create_approval_request` resolves the chain or raises.
  const noChain = routing.data !== undefined && routing.data.chains.length === 0;

  const blockers: string[] = [];
  if (paise === null || paise <= 0) blockers.push(t("apply.claim.blocked.amount"));
  if (rangeInvalid) blockers.push(t("apply.claim.blocked.range"));
  if (futureDated) blockers.push(t("apply.claim.blocked.future"));
  if (descriptionTooShort) blockers.push(t("apply.claim.blocked.description"));
  if (noChain) blockers.push(t("apply.claim.blocked.chain"));
  if (type.data === null) blockers.push(t("apply.type.missing"));

  const canSubmit = blockers.length === 0 && !submit.isPending;

  function onSubmit() {
    if (!canSubmit) return;
    setSubmitted(null);
    submit.mutate(
      {
        claimType,
        periodFrom,
        periodTo,
        amountRupees,
        description,
        eventReference: eventReference.trim() === "" ? null : eventReference.trim(),
        receiptRequired,
      },
      {
        onSuccess: (result) => {
          setSubmitted(result);
          setAmountRupees("");
          setDescription("");
          setEventReference("");
        },
      },
    );
  }

  const claimColumns: DataGridColumn<ClaimRow>[] = [
    {
      key: "claim_number",
      header: t("apply.claim.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.claim_number}</span>,
    },
    {
      key: "claim_type",
      header: t("apply.claim.col.head"),
      render: (row) => CLAIM_TYPE_LABEL[row.claim_type],
    },
    {
      key: "period_from",
      header: t("apply.claim.col.incurred"),
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
        icon={Wallet}
        title={t("apply.claim.title")}
        subtitle={t("apply.claim.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/apply">{t("apply.back")}</Link>
          </Button>
        }
      />

      {submitted !== null ? (
        <div className="mb-6">
          <Notice tone="success">
            <p className="font-medium">
              {t("apply.claim.done.title", { ref: submitted.claim.claim_number })}
            </p>
            <p className="mt-1">
              {t("apply.claim.done.hint", {
                request: submitted.requestNumber ?? dash(null),
              })}
            </p>
          </Notice>
        </div>
      ) : null}

      <StateBoundary
        loading={type.isLoading}
        error={type.error ?? undefined}
        onRetry={() => void type.refetch()}
        skeletonRows={4}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ── The form ─────────────────────────────────────────────────── */}
          <section aria-labelledby="claim-form">
            <h2 id="claim-form" className="mb-3 font-display text-lg font-semibold">
              {t("apply.claim.form.title")}
            </h2>
            <div className="space-y-4 rounded-lg border bg-card p-4">
              <div>
                <Label htmlFor="claim-type">{t("apply.claim.field.head")}</Label>
                <select
                  id="claim-type"
                  value={claimType}
                  onChange={(e) => {
                    if (isClaimType(e.target.value)) setClaimType(e.target.value);
                  }}
                  className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {claimTypeValues.map((value) => (
                    <option key={value} value={value}>
                      {CLAIM_TYPE_LABEL[value]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("apply.claim.field.head.hint")}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="claim-from">{t("apply.claim.field.from")}</Label>
                  <Input
                    id="claim-from"
                    type="date"
                    max={today}
                    className="mt-1.5 h-11"
                    value={periodFrom}
                    onChange={(e) => setPeriodFrom(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="claim-to">{t("apply.claim.field.to")}</Label>
                  <Input
                    id="claim-to"
                    type="date"
                    max={today}
                    className={cn("mt-1.5 h-11", rangeInvalid && "border-destructive")}
                    value={periodTo}
                    onChange={(e) => setPeriodTo(e.target.value)}
                    aria-invalid={rangeInvalid}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="claim-amount">{t("apply.claim.field.amount")}</Label>
                <Input
                  id="claim-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={t("apply.claim.field.amount.placeholder")}
                  className={cn("mt-1.5 h-11 num", amountInvalid && "border-destructive")}
                  value={amountRupees}
                  onChange={(e) => setAmountRupees(e.target.value)}
                  aria-invalid={amountInvalid}
                  aria-describedby="claim-amount-hint"
                />
                <p
                  id="claim-amount-hint"
                  className={cn(
                    "mt-1 text-xs",
                    amountInvalid ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {amountInvalid
                    ? t("apply.claim.field.amount.invalid")
                    : t("apply.claim.field.amount.hint")}
                </p>
                {paise !== null && paise > 0 ? (
                  <p className="mt-1 text-sm">
                    {t("apply.claim.field.amount.reads")}{" "}
                    <Money paise={paise} className="font-medium" />
                  </p>
                ) : null}
              </div>

              <div>
                <Label htmlFor="claim-event">{t("apply.claim.field.event")}</Label>
                <Input
                  id="claim-event"
                  className="mt-1.5 h-11"
                  maxLength={120}
                  placeholder={t("apply.claim.field.event.placeholder")}
                  value={eventReference}
                  onChange={(e) => setEventReference(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("apply.claim.field.event.hint")}
                </p>
              </div>

              <div>
                <Label htmlFor="claim-description">{t("apply.claim.field.description")}</Label>
                <textarea
                  id="claim-description"
                  rows={3}
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("apply.claim.field.description.placeholder")}
                  aria-describedby="claim-description-hint"
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p id="claim-description-hint" className="mt-1 text-xs text-muted-foreground">
                  {t("apply.claim.field.description.hint")}
                </p>
              </div>

              {receiptRequired ? (
                <Notice tone="warning">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Paperclip className="h-4 w-4" aria-hidden />
                    {t("apply.claim.receipt.title")}
                  </p>
                  <p className="mt-1">{t("apply.claim.receipt.hint")}</p>
                </Notice>
              ) : null}

              {submit.isError ? (
                <Notice tone="error">
                  <p className="font-medium">{t("apply.claim.refused.title")}</p>
                  <p className="mt-1 break-words">{mutationUserMessage(submit.error)}</p>
                </Notice>
              ) : null}

              {blockers.length > 0 ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <p className="font-medium">{t("apply.claim.blocked.title")}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={!canSubmit}
                onClick={onSubmit}
              >
                {submit.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {t("apply.claim.submitting")}
                  </>
                ) : (
                  t("apply.claim.submit")
                )}
              </Button>
              <p className="text-xs text-muted-foreground">{t("apply.claim.submit.hint")}</p>
            </div>
          </section>

          {/* ── Routing, caps and the type's own rules ───────────────────── */}
          <section aria-labelledby="claim-routing" className="space-y-4">
            <h2 id="claim-routing" className="font-display text-lg font-semibold">
              {t("apply.routing.section")}
            </h2>

            {type.data !== undefined && type.data !== null ? (
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
              </div>
            ) : null}

            <StateBoundary
              loading={routing.isLoading}
              error={routing.error ?? undefined}
              onRetry={() => void routing.refetch()}
              skeletonRows={2}
            >
              <RequestRoutingCard
                routing={routing.data}
                missingChainMessage={t("apply.claim.blocked.chain")}
              />
            </StateBoundary>

            <Notice tone="info">
              <p className="font-medium">{t("apply.claim.caps.title")}</p>
              <p className="mt-1">{t("apply.claim.caps.hint")}</p>
            </Notice>
          </section>
        </div>

        {/* ── In flight, then the claim ledger ──────────────────────────── */}
        <section className="mt-8" aria-labelledby="claim-open">
          <h2 id="claim-open" className="mb-3 font-display text-lg font-semibold">
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
              emptyTitle={t("apply.claim.mine.empty.title")}
              emptyHint={t("apply.claim.mine.empty.hint")}
            />
          </StateBoundary>
        </section>

        <section className="mt-8" aria-labelledby="claim-ledger">
          <h2 id="claim-ledger" className="font-display text-lg font-semibold">
            {t("apply.claim.ledger.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.claim.ledger.hint")}</p>
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
                  title={t("apply.claim.ledger.empty.title")}
                  hint={t("apply.claim.ledger.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </section>
      </StateBoundary>
    </div>
  );
}
