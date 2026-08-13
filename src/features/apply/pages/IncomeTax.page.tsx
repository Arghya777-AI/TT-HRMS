/**
 * E-10.6 · /me/apply/tax — "Regime election; full declarations arrive in a later
 * phase."
 *
 * This is the ONE of the three P2 request screens the deployed backend can
 * actually accept, and it accepts the half of the screen the manifest hint
 * scopes it to: the REGIME ELECTION really submits, while the full investment
 * declaration is named as the gap it is.
 *
 * WHY THE ELECTION WORKS. It does not ride on `IT_DECLARATION`, whose
 * `detail_table` is `income_tax_declarations` — a table no migration creates,
 * present only as a string in `ck_request_types__detail_table` (029 §1) and in
 * the 045 §2 seed row, and with no approval chain either. It rides on the path
 * the schema actually provides for a statutory FIELD change:
 *
 *   `employee_change_requests` (011 §2) — a real table, self-insertable through
 *   `ecr__self_insert`, whose `ck_ecr__entity_table` whitelist NAMES
 *   `employee_statutory`; `tax_regime` is one of that table's columns with
 *   `ck_es__regime CHECK (tax_regime IN ('old','new'))` (009 §6).
 *     ↓
 *   `PROFILE_CHANGE`, whose `detail_table` IS `employee_change_requests` and
 *   which 045 §3 gives the `AC-PROFILE` chain (one level, HR admin) — so
 *   `create_approval_request` resolves a chain and mints `request_number` from
 *   `seq_approval_request_number` instead of raising.
 *
 * WHAT THE SERVER DOES NOT DO, AND THE SCREEN THEREFORE SAYS: approval does not
 * flip the regime by itself. `apply_change_request` (011 §3) updates a satellite
 * with `WHERE id = $2 AND employee_id = $3`, and `employee_statutory` is keyed on
 * `employee_id` with no `id` column, so HR sets the value; the approval request
 * is the record of the election. `employee_change_requests.approval_request_id`
 * also stays NULL, because `authenticated` holds INSERT but not UPDATE on that
 * table — the link runs the other way, through `approval_requests.detail_id`.
 *
 * The rate ladder is real too: `statutory_settings__authenticated__select` is
 * `USING (true)` — 020's comment says why, "statutory rates are law, not
 * secrets" — so both regimes' slabs, standard deduction, 87A rebate and cess are
 * read from `tds_config` and DECODED. Not one figure on this screen is computed:
 * no tax is projected, no regime is recommended, no total is added up.
 *
 * @route /me/apply/tax
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Landmark, Loader2, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Money } from "@/shared/ui/Money";
import { Notice } from "@/features/admin/components/Notice";
import { TaxDeclarationForm } from "../components/TaxDeclarationForm";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { dash, formatPercent } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { mutationUserMessage } from "@/shared/api/query";
import {
  readElectionRegime,
  readTdsFinancialYear,
  readTdsRegime,
  taxRegimeValues,
  REQUEST_CODE_IT_DECLARATION,
  REQUEST_CODE_PROFILE_CHANGE,
  type RegimeElection,
  type SubmittedRegimeElection,
  type TaxRegime,
} from "../api/apply-forms.api";
import { useMyOpenRequestsOfType, useRequestRouting, useRequestTypeByCode } from "../hooks/useApply";
import {
  useCurrentTaxRateSet,
  useMyRegimeElections,
  useMyTaxProfile,
  useSubmitRegimeElection,
} from "../hooks/useApplyForms";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";
import { RequestRoutingCard } from "../components/RequestRoutingCard";

/** `ck_es__regime`'s two values, in the words an employee recognises. */
const REGIME_LABEL: Readonly<Record<TaxRegime, string>> = {
  old: t("apply.tax.regime.old"),
  new: t("apply.tax.regime.new"),
};

const REGIME_HINT: Readonly<Record<TaxRegime, string>> = {
  old: t("apply.tax.regime.old.hint"),
  new: t("apply.tax.regime.new.hint"),
};

/** `public.approval_status` as it applies to the CHANGE REQUEST row. */
const ELECTION_STATUS_MAP: Record<string, StatusChipEntry> = {
  draft: { label: t("apply.tax.status.draft"), tone: "neutral" },
  pending: { label: t("apply.tax.status.pending"), tone: "warn" },
  in_progress: { label: t("apply.tax.status.pending"), tone: "warn" },
  approved: { label: t("apply.tax.status.approved"), tone: "success" },
  applied: { label: t("apply.tax.status.applied"), tone: "success" },
  rejected: { label: t("apply.tax.status.rejected"), tone: "danger" },
  cancelled: { label: t("apply.tax.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("apply.tax.status.cancelled"), tone: "neutral" },
  failed: { label: t("apply.tax.status.failed"), tone: "danger" },
};

/** Same floor as the claim screen's description — our minimum, not the DB's. */
const MIN_NOTE = 10;

/**
 * One regime's ladder, straight out of `tds_config`. Slab bounds are ANNUAL
 * integer paise, so they render through `<Money>`; `pct` is already a percentage
 * (schema convention) and only gets a '%' appended.
 */
function RegimeLadder({
  regime,
  config,
  isCurrent,
}: {
  regime: TaxRegime;
  config: unknown;
  isCurrent: boolean;
}) {
  const decoded = readTdsRegime(config, regime);

  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold">{REGIME_LABEL[regime]}</h3>
        {isCurrent ? <Badge variant="success">{t("apply.tax.ladder.yours")}</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{REGIME_HINT[regime]}</p>

      {decoded === null ? (
        <div className="mt-3">
          <Notice tone="warning">{t("apply.tax.ladder.undecodable")}</Notice>
        </div>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("apply.tax.ladder.standardDeduction")}</dt>
            <dd className="text-right">
              <Money paise={decoded.standard_deduction} />
            </dd>
            <dt className="text-muted-foreground">{t("apply.tax.ladder.rebateThreshold")}</dt>
            <dd className="text-right">
              {decoded.rebate_87a_threshold === null ? (
                dash(null)
              ) : (
                <Money paise={decoded.rebate_87a_threshold} />
              )}
            </dd>
            <dt className="text-muted-foreground">{t("apply.tax.ladder.rebateAmount")}</dt>
            <dd className="text-right">
              {decoded.rebate_87a_amount === null ? (
                dash(null)
              ) : (
                <Money paise={decoded.rebate_87a_amount} />
              )}
            </dd>
            <dt className="text-muted-foreground">{t("apply.tax.ladder.cess")}</dt>
            <dd className="num text-right">{formatPercent(decoded.cess_pct)}</dd>
          </dl>

          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">
              {t("apply.tax.ladder.caption", { regime: REGIME_LABEL[regime] })}
            </caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 text-left font-medium">
                  {t("apply.tax.ladder.slab")}
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  {t("apply.tax.ladder.rate")}
                </th>
              </tr>
            </thead>
            <tbody>
              {decoded.slabs.map((slab) => (
                <tr key={`${regime}-${slab.from}`} className="border-b last:border-0">
                  {/* An open-ended top slab reads "… and above", never "… – —". */}
                  <td className="py-1.5">
                    <Money paise={slab.from} />
                    {slab.to === null ? (
                      ` ${t("apply.tax.ladder.above")}`
                    ) : (
                      <>
                        {" – "}
                        <Money paise={slab.to} />
                      </>
                    )}
                  </td>
                  <td className="num py-1.5 text-right">{formatPercent(slab.pct, { digits: 0 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </li>
  );
}

export default function IncomeTaxPage() {
  const profile = useMyTaxProfile();
  const rateSet = useCurrentTaxRateSet();
  // Hoisted so the narrowing survives into the .map() callback below: TypeScript
  // discards narrowing of a PROPERTY access (rateSet.data) inside a closure, but
  // keeps it for a const.
  const rates = rateSet.data ?? null;
  const elections = useMyRegimeElections();
  const submit = useSubmitRegimeElection();

  /** The type that CARRIES the election, and the type that will carry the rest. */
  const changeType = useRequestTypeByCode(REQUEST_CODE_PROFILE_CHANGE);
  const changeRouting = useRequestRouting(changeType.data?.id);
  const changeOpen = useMyOpenRequestsOfType(changeType.data?.id);
  const declarationType = useRequestTypeByCode(REQUEST_CODE_IT_DECLARATION);
  const declarationRouting = useRequestRouting(declarationType.data?.id);

  const [chosen, setChosen] = useState<TaxRegime | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState<SubmittedRegimeElection | null>(null);

  const current = profile.data?.tax_regime ?? null;
  const lockedFy = profile.data?.tax_regime_locked_fy ?? null;
  const financialYear = readTdsFinancialYear(rateSet.data?.tds_config);

  // No chain, no request: `create_approval_request` resolves a chain or raises.
  const noChain = changeRouting.data !== undefined && changeRouting.data.chains.length === 0;
  const noteTooShort = note.trim().length < MIN_NOTE;

  const blockers: string[] = [];
  if (profile.data === null && !profile.isLoading) blockers.push(t("apply.tax.blocked.noStatutory"));
  if (lockedFy !== null) blockers.push(t("apply.tax.blocked.locked", { fy: lockedFy }));
  if (chosen === null) blockers.push(t("apply.tax.blocked.pick"));
  if (chosen !== null && chosen === current) blockers.push(t("apply.tax.blocked.same"));
  if (noteTooShort) blockers.push(t("apply.tax.blocked.note"));
  if (noChain) blockers.push(t("apply.tax.blocked.chain"));
  if (changeType.data === null) blockers.push(t("apply.type.missing"));

  const canSubmit = blockers.length === 0 && !submit.isPending;

  function onSubmit() {
    if (!canSubmit || chosen === null || current === null) return;
    setSubmitted(null);
    submit.mutate(
      { regime: chosen, currentRegime: current, note, financialYear },
      {
        onSuccess: (result) => {
          setSubmitted(result);
          setChosen(null);
          setNote("");
        },
      },
    );
  }

  const electionColumns: DataGridColumn<RegimeElection>[] = [
    {
      key: "requested_at",
      header: t("apply.tax.col.raised"),
      width: "13rem",
      sortable: true,
      render: (row) => fmtDateTime(row.requested_at),
    },
    {
      key: "new_value",
      header: t("apply.tax.col.change"),
      render: (row) => {
        const from = readElectionRegime(row.old_value);
        const to = readElectionRegime(row.new_value);
        return `${from === null ? dash(null) : REGIME_LABEL[from]} → ${
          to === null ? dash(null) : REGIME_LABEL[to]
        }`;
      },
    },
    {
      key: "status",
      header: t("apply.tax.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={ELECTION_STATUS_MAP} />,
    },
    {
      key: "effective_from",
      header: t("apply.tax.col.effective"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.effective_from),
    },
    {
      key: "apply_error",
      header: t("apply.tax.col.applyNote"),
      hideBelow: "lg",
      render: (row) =>
        row.apply_error !== null
          ? row.apply_error
          : row.applied_at !== null
            ? fmtDateTime(row.applied_at)
            : dash(null),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={FileText}
        title={t("apply.tax.title")}
        subtitle={t("apply.tax.subtitle")}
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
              {t("apply.tax.done.title", { ref: submitted.requestNumber ?? dash(null) })}
            </p>
            <p className="mt-1">{t("apply.tax.done.hint")}</p>
          </Notice>
        </div>
      ) : null}

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── The regime on file ─────────────────────────────────────────── */}
          <section aria-labelledby="tax-current">
            <h2 id="tax-current" className="mb-3 font-display text-lg font-semibold">
              {t("apply.tax.current.title")}
            </h2>
            <StateBoundary
              loading={profile.isLoading}
              error={profile.error ?? undefined}
              onRetry={() => void profile.refetch()}
              isEmpty={profile.data === null && !profile.isLoading}
              empty={
                <EmptyState
                  icon={Landmark}
                  title={t("apply.tax.current.empty.title")}
                  hint={t("apply.tax.current.empty.hint")}
                />
              }
              skeletonRows={3}
            >
              <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {current === null ? null : (
                    <Badge variant="info">{REGIME_LABEL[current]}</Badge>
                  )}
                  {financialYear === null ? null : (
                    <Badge variant="neutral">{t("apply.tax.current.fy", { fy: financialYear })}</Badge>
                  )}
                  {lockedFy === null ? (
                    <Badge variant="success">{t("apply.tax.current.open")}</Badge>
                  ) : (
                    <Badge variant="warning">{t("apply.tax.current.locked", { fy: lockedFy })}</Badge>
                  )}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("apply.tax.current.hint")}
                </p>

                {!profile.data ? null : (
                  <ul className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
                    <li>
                      <Badge variant={profile.data.pf_applicable ? "neutral" : "outline"}>
                        {profile.data.pf_applicable
                          ? t("apply.tax.flag.pfYes")
                          : t("apply.tax.flag.pfNo")}
                      </Badge>
                    </li>
                    <li>
                      <Badge variant={profile.data.esi_applicable ? "neutral" : "outline"}>
                        {profile.data.esi_applicable
                          ? t("apply.tax.flag.esiYes")
                          : t("apply.tax.flag.esiNo")}
                      </Badge>
                    </li>
                    <li>
                      <Badge variant={profile.data.professional_tax_applicable ? "neutral" : "outline"}>
                        {profile.data.professional_tax_applicable
                          ? t("apply.tax.flag.ptYes", { state: profile.data.professional_tax_state })
                          : t("apply.tax.flag.ptNo")}
                      </Badge>
                    </li>
                    <li>
                      <Badge variant={profile.data.lwf_applicable ? "neutral" : "outline"}>
                        {profile.data.lwf_applicable
                          ? t("apply.tax.flag.lwfYes")
                          : t("apply.tax.flag.lwfNo")}
                      </Badge>
                    </li>
                  </ul>
                )}
              </div>
            </StateBoundary>
          </section>

          {/* ── The election ───────────────────────────────────────────────── */}
          <section aria-labelledby="tax-elect">
            <h2 id="tax-elect" className="mb-3 font-display text-lg font-semibold">
              {t("apply.tax.form.title")}
            </h2>
            <div className="space-y-4 rounded-lg border bg-card p-4">
              <fieldset>
                <legend className="text-sm font-medium">{t("apply.tax.field.regime")}</legend>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("apply.tax.field.regime.hint")}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {taxRegimeValues.map((value) => {
                    const selected = chosen === value;
                    const isCurrent = current === value;
                    return (
                      <label
                        key={value}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm",
                          selected ? "border-primary bg-primary/5" : "bg-background",
                          isCurrent && "opacity-70",
                        )}
                      >
                        <input
                          type="radio"
                          name="tax-regime"
                          className="mt-0.5"
                          value={value}
                          checked={selected}
                          onChange={() => setChosen(value)}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{REGIME_LABEL[value]}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {isCurrent ? t("apply.tax.field.isCurrent") : REGIME_HINT[value]}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div>
                <Label htmlFor="tax-note">{t("apply.tax.field.note")}</Label>
                <textarea
                  id="tax-note"
                  rows={3}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("apply.tax.field.note.placeholder")}
                  aria-describedby="tax-note-hint"
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p id="tax-note-hint" className="mt-1 text-xs text-muted-foreground">
                  {t("apply.tax.field.note.hint")}
                </p>
              </div>

              <Notice tone="info">
                <p className="font-medium">{t("apply.tax.route.title")}</p>
                <p className="mt-1">{t("apply.tax.route.hint")}</p>
              </Notice>

              {submit.isError ? (
                <Notice tone="error">
                  <p className="font-medium">{t("apply.tax.refused.title")}</p>
                  <p className="mt-1 break-words">{mutationUserMessage(submit.error)}</p>
                </Notice>
              ) : null}

              {blockers.length > 0 ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <p className="font-medium">{t("apply.tax.blocked.title")}</p>
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
                    {t("apply.tax.submitting")}
                  </>
                ) : (
                  t("apply.tax.submit")
                )}
              </Button>
              <p className="text-xs text-muted-foreground">{t("apply.tax.submit.hint")}</p>
            </div>
          </section>
        </div>

        {/* ── Who decides the election ────────────────────────────────────── */}
        <section aria-labelledby="tax-routing">
          <h2 id="tax-routing" className="mb-3 font-display text-lg font-semibold">
            {t("apply.routing.section")}
          </h2>
          <StateBoundary
            loading={changeType.isLoading || changeRouting.isLoading}
            error={changeType.error ?? changeRouting.error ?? undefined}
            onRetry={() => {
              void changeType.refetch();
              void changeRouting.refetch();
            }}
            skeletonRows={2}
          >
            {changeType.data === null ? (
              <Notice tone="warning">{t("apply.type.missing")}</Notice>
            ) : (
              <div className="space-y-3">
                {changeType.data !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="neutral">{changeType.data.name}</Badge>
                    <span>{t("apply.tile.sla", { hours: changeType.data.sla_hours })}</span>
                    <span>
                      {changeType.data.allows_withdrawal
                        ? t("apply.type.withdrawable")
                        : t("apply.type.notWithdrawable")}
                    </span>
                    <span>
                      {t("apply.type.detailTable", { table: changeType.data.detail_table })}
                    </span>
                  </div>
                ) : null}
                <RequestRoutingCard
                  routing={changeRouting.data}
                  missingChainMessage={t("apply.tax.blocked.chain")}
                />
              </div>
            )}
          </StateBoundary>
        </section>

        {/* ── The rate ladder both regimes are read from ──────────────────── */}
        <section aria-labelledby="tax-ladders">
          <h2 id="tax-ladders" className="font-display text-lg font-semibold">
            {t("apply.tax.ladders.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.tax.ladders.hint")}</p>
          <StateBoundary
            loading={rateSet.isLoading}
            error={rateSet.error ?? undefined}
            onRetry={() => void rateSet.refetch()}
            isEmpty={rateSet.data === null && !rateSet.isLoading}
            empty={
              <EmptyState
                icon={Scale}
                title={t("apply.tax.ladders.empty.title")}
                hint={t("apply.tax.ladders.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            {rates === null ? null : (
              <>
                <ul className="grid gap-4 lg:grid-cols-2">
                  {taxRegimeValues.map((value) => (
                    <RegimeLadder
                      key={value}
                      regime={value}
                      config={rates.tds_config}
                      isCurrent={current === value}
                    />
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("apply.tax.ladders.source", {
                    from: fmtCivilDate(rates.effective_from),
                  })}
                </p>
                {rates.notes === null ? null : (
                  <p className="mt-1 text-xs text-muted-foreground">{rates.notes}</p>
                )}
              </>
            )}
          </StateBoundary>
        </section>

        {/* ── My elections, from the change-request table itself ──────────── */}
        <section aria-labelledby="tax-ledger">
          <h2 id="tax-ledger" className="font-display text-lg font-semibold">
            {t("apply.tax.ledger.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.tax.ledger.hint")}</p>
          <StateBoundary
            loading={elections.isLoading}
            error={elections.error ?? undefined}
            onRetry={() => void elections.refetch()}
          >
            <DataGrid
              columns={electionColumns}
              rows={elections.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
              emptyState={
                <EmptyState
                  icon={Landmark}
                  title={t("apply.tax.ledger.empty.title")}
                  hint={t("apply.tax.ledger.empty.hint")}
                />
              }
            />
          </StateBoundary>
        </section>

        {/* ── Anything of the carrying type already in flight ─────────────── */}
        <section aria-labelledby="tax-open">
          <h2 id="tax-open" className="mb-3 font-display text-lg font-semibold">
            {t("apply.mine.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.tax.mine.hint")}</p>
          <StateBoundary
            loading={changeOpen.isLoading}
            error={changeOpen.error ?? undefined}
            onRetry={() => void changeOpen.refetch()}
          >
            <OpenRequestsGrid
              rows={changeOpen.data?.rows ?? []}
              approvers={changeOpen.data?.approvers ?? {}}
              emptyTitle={t("apply.tax.mine.empty.title")}
              emptyHint={t("apply.tax.mine.empty.hint")}
            />
          </StateBoundary>
        </section>

        {/*
          ── The half that WAS declared not live, and always was ───────────────

          Three bullets here said the table, the chain and the section fields did
          not exist. Migration 041300 created all three; the notice predated it and
          was never revisited, so a statutory feature sat in the database while
          every employee was told it was missing — and payroll went on computing
          TDS on the regime alone because nobody could file deductions.
        */}
        <section aria-labelledby="tax-declaration">
          <h2 id="tax-declaration" className="mb-3 font-display text-lg font-semibold">
            {t("apply.tax.declaration.title")}
          </h2>
          <div className="space-y-3">
            <TaxDeclarationForm financialYear={financialYear} regime={chosen ?? "new"} />
            <StateBoundary
              loading={declarationType.isLoading || declarationRouting.isLoading}
              error={declarationType.error ?? declarationRouting.error ?? undefined}
              onRetry={() => {
                void declarationType.refetch();
                void declarationRouting.refetch();
              }}
              skeletonRows={2}
            >
              {declarationType.data === null ? (
                <Notice tone="warning">{t("apply.type.missing")}</Notice>
              ) : (
                <div className="space-y-3">
                  {declarationType.data !== undefined ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="neutral">{declarationType.data.name}</Badge>
                      <span>{t("apply.tile.sla", { hours: declarationType.data.sla_hours })}</span>
                      <span>
                        {t("apply.type.detailTable", {
                          table: declarationType.data.detail_table,
                        })}
                      </span>
                    </div>
                  ) : null}
                  <RequestRoutingCard
                    routing={declarationRouting.data}
                    missingChainMessage={t("apply.tax.declaration.gap.chain")}
                  />
                </div>
              )}
            </StateBoundary>
          </div>
        </section>
      </div>
    </div>
  );
}
