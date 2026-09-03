/**
 * §8 · /admin/reimbursements — every claim, what it adds up to, and what to do about it.
 *
 * ── WHY THIS EXISTS ALONGSIDE /admin/payroll/reimbursements ─────────────────
 * Asked for: "How can the admin check which reimbursements have been processed, which are
 * done, and which are pending? There should be a reimbursement page to understand everything,
 * with month/year filtering, so they can view the totals: who claimed how much, and for what
 * purpose."
 *
 * None of that existed. The payroll page answers a DIFFERENT question — which approved claims
 * a payroll RUN will pay — so its slices are routed/unrouted, it cannot filter by month, and
 * its own header says "not one amount is added up here". Both pages are kept because both
 * questions are real, and they share one implementation of every ACTION (`useDecideClaim`,
 * `recordClaimPayment`) so a decision can never mean two different things depending on which
 * screen took it.
 *
 * ── THE THREE STATES, IN THE VENUE'S OWN WORDS ──────────────────────────────
 *   pending    somebody still has to decide it
 *   processed  approved, and not yet paid — what the venue OWES
 *   done       paid out, with a date and a reference
 *
 * `outstanding` is the figure to read first: approved money nobody has paid. It is why the
 * summary shows four amounts rather than one.
 *
 * ── AND WHY THE PERIOD HAS A BASIS ──────────────────────────────────────────
 * A claim carries three dates and the venue's own rows disagree: CLM-2026-000003 covers 26-30
 * AUGUST and was filed on 2 SEPTEMBER. September is 6,148 by expense period, 12,118 by filing
 * date and 0 by payment date. All three are correct answers to different questions, so the
 * basis is on screen. `period` is the default — "what did this month cost" is the budget
 * question — and `paid` is what an accountant reconciles against the bank.
 *
 * Every total is summed by Postgres over the same period and basis the table filters on, so a
 * tile can never describe a different row set from the list beneath it.
 *
 * @route /admin/reimbursements
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Download, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fmtCivilDate, fmtCivilMonth, istToday } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { ClaimEvidenceSheet } from "../components/ClaimEvidenceSheet";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useClaimLineEvidence } from "../hooks/useClaimEvidence";
import {
  useClaimDecisionTargets,
  useDecideClaim,
  useReimbursementClaimCount,
  useReimbursementClaims,
} from "../hooks/usePayrollStatutory";
import {
  CLAIM_PERIOD_BASES,
  CLAIM_TYPES,
  isClaimPeriodBasis,
  isClaimSlice,
  isClaimType,
  type ClaimPeriodBasis,
  type ClaimSlice,
  type ClaimType,
  type ReimbursementClaim,
} from "../api/payroll-statutory.api";
import {
  fetchReimbursementByType,
  fetchReimbursementSummary,
  financialYearPeriod,
  monthPeriod,
  recentMonths,
} from "../api/reimbursementAdmin.api";
import { downloadCsv, paiseToRupeeString, toCsv } from "../reimbursementCsv";

/** `approval_status`, in HR's words. Never the raw enum. */
const CLAIM_STATUS_CHIP: Record<string, StatusChipEntry> = {
  draft: { label: t("admin.reimb.status.draft"), tone: "neutral" },
  pending: { label: t("admin.reimb.status.pending"), tone: "warn" },
  in_progress: { label: t("admin.reimb.status.inProgress"), tone: "warn" },
  escalated: { label: t("admin.reimb.status.escalated"), tone: "danger" },
  approved: { label: t("admin.reimb.status.approved"), tone: "success" },
  auto_approved: { label: t("admin.reimb.status.autoApproved"), tone: "success" },
  applied: { label: t("admin.reimb.status.applied"), tone: "success" },
  rejected: { label: t("admin.reimb.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.reimb.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.reimb.status.withdrawn"), tone: "neutral" },
  expired: { label: t("admin.reimb.status.expired"), tone: "neutral" },
  failed: { label: t("admin.reimb.status.failed"), tone: "danger" },
};

/*
  ── EXHAUSTIVE RECORDS, NOT TEMPLATE KEYS ──────────────────────────────────
  `t()` has NO missing-key fallback: `en[key]` is undefined and `t` returns it unchanged, so a
  templated key that does not exist renders an EMPTY cell. A `Record` typed on the union makes
  a new claim type or a new basis a COMPILE error instead.

  The first version of `claimTypeLabel` also returned the key string itself as the label for an
  unknown code — so a type outside the list would have printed "admin.reimb.type.whatever" on
  screen beside somebody's money.
*/
const CLAIM_TYPE_LABEL: Record<ClaimType, MessageKey> = {
  local_conveyance: "admin.radm.type.local_conveyance",
  travel: "admin.radm.type.travel",
  food: "admin.radm.type.food",
  medical: "admin.radm.type.medical",
  telephone: "admin.radm.type.telephone",
  uniform: "admin.radm.type.uniform",
  fuel: "admin.radm.type.fuel",
  guest_hospitality: "admin.radm.type.guest_hospitality",
  misc: "admin.radm.type.misc",
};

const BASIS_LABEL: Record<ClaimPeriodBasis, MessageKey> = {
  period: "admin.radm.basis.period",
  filed: "admin.radm.basis.filed",
  paid: "admin.radm.basis.paid",
};

const BASIS_HINT: Record<ClaimPeriodBasis, MessageKey> = {
  period: "admin.radm.basis.hint.period",
  filed: "admin.radm.basis.hint.filed",
  paid: "admin.radm.basis.hint.paid",
};

/**
 * A claim type in HR's words.
 *
 * An unrecognised code prints ITSELF rather than a message key — `ck_rc__claim_type` permits
 * only the nine, so this is unreachable today, and if the constraint ever widens the screen
 * shows the raw value instead of a broken lookup.
 */
function claimTypeLabel(code: string): string {
  return isClaimType(code) ? t(CLAIM_TYPE_LABEL[code]) : code;
}

/**
 * What a claim was FOR, in one cell.
 *
 * Assembled from the LINES, not the header: the header carries only an optional
 * `event_reference`, while the description an employee actually typed lives on each line.
 * Distinct values, so a five-line taxi claim reads "Conveyance" once rather than five times.
 *
 * A pure module function taking the map as an argument, rather than a closure inside the
 * component. As a closure it was a missing `useMemo` dependency: correct today, because the
 * map it reads is already a dependency, but one edit away from the columns capturing a stale
 * copy and every purpose cell freezing. Out here the question cannot arise.
 */
function claimPurpose(
  row: ReimbursementClaim,
  byClaim: ReadonlyMap<string, readonly { line: { description: string | null; expense_head: string | null } }[]> | undefined,
): string {
  const lines = byClaim?.get(row.id) ?? [];
  const parts = [
    ...new Set(
      lines
        .map(({ line }) => (line.description ?? line.expense_head ?? "").trim())
        .filter((x) => x !== ""),
    ),
  ];
  return parts.length === 0 ? dash(row.event_reference) : parts.join("; ");
}

interface Decision {
  readonly row: ReimbursementClaim;
  readonly decision: "approve" | "reject";
}

export function ReimbursementAdminPage() {
  const [params, setParams] = useSearchParams();
  const today = istToday();
  const months = useMemo(() => recentMonths(today), [today]);

  const scope = params.get("scope") === "fy" ? "fy" : "month";
  const month = params.get("month") ?? months[0] ?? today.slice(0, 7);
  const basisParam = params.get("basis");
  const basis: ClaimPeriodBasis = isClaimPeriodBasis(basisParam) ? basisParam : "period";
  const sliceParam = params.get("slice");
  const slice: ClaimSlice | null = isClaimSlice(sliceParam) ? sliceParam : null;
  const typeParam = params.get("type");
  const claimType: ClaimType | null =
    typeParam !== null && isClaimType(typeParam) ? typeParam : null;

  const period = useMemo(
    () => (scope === "fy" ? financialYearPeriod(`${month}-01`) : monthPeriod(`${month}-01`)),
    [scope, month],
  );

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  /*
    ONE filter object for the rows, the count and the summary. The summary is a Postgres
    aggregate over the same period and basis, so the tiles and the table cannot disagree.
  */
  /*
    ── THE PENDING BAND IS NOT PERIOD-SCOPED ─────────────────────────────────
    Reported as "pending bills are not showing", and the figures were right: the one pending
    claim has an expense period ending 30 August and was filed on 2 September, so the default
    September-by-expense-period view excluded it and Pending read 0 while somebody waited.

    A total is about a period; a queue is about now. So choosing Pending drops the period
    entirely and shows everything awaiting a decision.
  */
  const queueOnly = slice === "awaiting";
  const filters = useMemo(
    () => ({
      slice,
      claimType,
      from: period.from,
      to: period.to,
      basis,
      ignorePeriod: queueOnly,
    }),
    [slice, claimType, period.from, period.to, basis, queueOnly],
  );

  const claims = useReimbursementClaims(filters);
  const total = useReimbursementClaimCount(filters);
  const rows = useMemo(() => claims.data ?? [], [claims.data]);
  const labels = useEmployeeLabels();
  const targets = useClaimDecisionTargets();

  const summary = useQuery({
    queryKey: qk.admin.payslips({ part: "reimb-summary", ...period, basis }),
    queryFn: ({ signal }) => fetchReimbursementSummary(period.from, period.to, basis, signal),
    retry: shouldRetryQuery,
  });
  const byType = useQuery({
    queryKey: qk.admin.payslips({ part: "reimb-by-type", ...period, basis }),
    queryFn: ({ signal }) => fetchReimbursementByType(period.from, period.to, basis, signal),
    retry: shouldRetryQuery,
  });

  /* Lines carry the PURPOSE and the receipts — one request for the page, never per row. */
  const claimIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const evidence = useClaimLineEvidence(claimIds);
  const [evidenceFor, setEvidenceFor] = useState<ReimbursementClaim | null>(null);

  const [target, setTarget] = useState<Decision | null>(null);
  const decide = useDecideClaim();
  const labelMap = labels.data;
  const targetMap = targets.data;
  const byClaim = evidence.data?.byClaim;
  const s = summary.data;

  const purposeOf = useCallback(
    (row: ReimbursementClaim) => claimPurpose(row, byClaim),
    [byClaim],
  );

  const columns: DataGridColumn<ReimbursementClaim>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.radm.col.who"),
        width: "14rem",
        render: (row) => {
          const label = labelMap?.get(row.employee_id);
          return (
            <PersonCell
              code={label?.code ?? null}
              name={label?.name ?? null}
              secondary={label?.department ?? null}
            />
          );
        },
      },
      {
        key: "claim_number",
        header: t("admin.radm.col.claim"),
        width: "11rem",
        sortable: true,
        render: (row) => <span className="num text-xs font-medium">{row.claim_number}</span>,
      },
      {
        key: "claim_type",
        header: t("admin.radm.col.type"),
        width: "9rem",
        render: (row) => <span className="text-xs">{claimTypeLabel(row.claim_type)}</span>,
      },
      {
        key: "purpose",
        header: t("admin.radm.col.purpose"),
        width: "18rem",
        render: (row) => (
          <span className="block truncate text-xs" title={purposeOf(row)}>
            {purposeOf(row)}
          </span>
        ),
      },
      {
        key: "period",
        header: t("admin.radm.col.period"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="num text-xs">
            {row.period_from === null && row.period_to === null
              ? dash(null)
              : `${fmtCivilDate(row.period_from)} – ${fmtCivilDate(row.period_to)}`}
          </span>
        ),
      },
      {
        key: "total_claimed_paise",
        header: t("admin.radm.col.claimed"),
        width: "8rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.total_claimed_paise} />,
      },
      {
        key: "total_approved_paise",
        header: t("admin.radm.col.approved"),
        width: "8rem",
        align: "right",
        render: (row) => <Money paise={row.total_approved_paise} className="font-medium" />,
      },
      {
        key: "status",
        header: t("admin.radm.col.state"),
        width: "9rem",
        render: (row) => <StatusChip status={row.status} map={CLAIM_STATUS_CHIP} />,
      },
      {
        key: "paid",
        header: t("admin.radm.col.paid"),
        width: "11rem",
        render: (row) =>
          row.paid_on !== null ? (
            <span className="num text-xs">
              {fmtCivilDate(row.paid_on)}
              {row.payment_reference !== null ? ` · ${row.payment_reference}` : ""}
            </span>
          ) : row.paid_via_payroll_run_id !== null ? (
            <span className="text-xs">{t("admin.radm.inRun")}</span>
          ) : (
            /*
              APPROVED AND UNPAID IS THE STATE WORTH SEEING. It is not an error, and it is not
              "done" either — it is money the venue owes and nothing is scheduled to pay.
            */
            <span
              className={cn(
                "text-xs",
                row.status === "approved" || row.status === "applied" || row.status === "auto_approved"
                  ? "text-warning"
                  : "text-muted-foreground",
              )}
            >
              {row.status === "approved" || row.status === "applied" || row.status === "auto_approved"
                ? t("admin.radm.owed")
                : dash(null)}
            </span>
          ),
      },
      {
        key: "act",
        header: t("admin.radm.col.act"),
        width: "15rem",
        align: "right",
        render: (row) => {
          const decidable = targetMap?.get(row.id);
          return (
            <span className="flex flex-wrap justify-end gap-1.5">
              <Button variant="link" size="sm" className="h-auto p-0 text-xs"
                onClick={() => setEvidenceFor(row)}>
                {t("admin.radm.view")}
              </Button>
              {/*
                Decide buttons appear ONLY where the SERVER says this admin is the current
                approver — `v_approval_inbox` already filters to
                `current_employee_id() = ANY (current_approver_ids)`. Nobody is silently
                promoted into a chain they are not on.
              */}
              {decidable !== undefined ? (
                <>
                  <Button variant="outline" size="sm" disabled={decide.isPending}
                    onClick={() => setTarget({ row, decision: "reject" })}>
                    {t("admin.radm.reject")}
                  </Button>
                  <Button size="sm" disabled={decide.isPending}
                    onClick={() => setTarget({ row, decision: "approve" })}>
                    {t("admin.radm.approve")}
                  </Button>
                </>
              ) : null}
            </span>
          );
        },
      },
    ],
    [labelMap, targetMap, purposeOf, decide.isPending],
  );

  const exportCsv = (): void => {
    const csv = toCsv(rows, [
      { header: t("admin.radm.col.who"), value: (r) => labelMap?.get(r.employee_id)?.name ?? "" },
      { header: t("admin.radm.csv.code"), value: (r) => labelMap?.get(r.employee_id)?.code ?? "" },
      { header: t("admin.radm.col.claim"), value: (r) => r.claim_number },
      { header: t("admin.radm.col.type"), value: (r) => claimTypeLabel(r.claim_type) },
      { header: t("admin.radm.col.purpose"), value: purposeOf },
      { header: t("admin.radm.csv.periodFrom"), value: (r) => r.period_from ?? "" },
      { header: t("admin.radm.csv.periodTo"), value: (r) => r.period_to ?? "" },
      { header: t("admin.radm.csv.filed"), value: (r) => r.created_at.slice(0, 10) },
      { header: t("admin.radm.col.claimed"), value: (r) => paiseToRupeeString(r.total_claimed_paise) },
      { header: t("admin.radm.col.approved"), value: (r) => paiseToRupeeString(r.total_approved_paise) },
      { header: t("admin.radm.col.state"), value: (r) => CLAIM_STATUS_CHIP[r.status]?.label ?? r.status },
      { header: t("admin.radm.csv.paidOn"), value: (r) => r.paid_on ?? "" },
      { header: t("admin.radm.csv.reference"), value: (r) => r.payment_reference ?? "" },
    ]);
    downloadCsv(`reimbursements-${period.from}-to-${period.to}.csv`, csv);
  };

  return (
    <div className="container py-6">
      <PageHeader icon={Receipt} title={t("admin.radm.title")} subtitle={t("admin.radm.subtitle")} />

      {/* ── The period ─────────────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <SelectField
          label={t("admin.radm.scope")}
          value={scope}
          onChange={(v) => setParam("scope", v)}
          options={[
            { value: "month", label: t("admin.radm.scope.month") },
            { value: "fy", label: t("admin.radm.scope.fy") },
          ]}
        />
        <SelectField
          label={scope === "fy" ? t("admin.radm.inYearOf") : t("admin.radm.month")}
          value={month}
          onChange={(v) => setParam("month", v)}
          options={months.map((m) => ({ value: m, label: fmtCivilMonth(m) }))}
        />
        <SelectField
          label={t("admin.radm.basis")}
          value={basis}
          onChange={(v) => setParam("basis", v)}
          options={CLAIM_PERIOD_BASES.map((b) => ({
            value: b,
            label: t(BASIS_LABEL[b]),
          }))}
        />
        <SelectField
          label={t("admin.radm.type")}
          value={claimType ?? ""}
          onChange={(v) => setParam("type", v)}
          options={[
            { value: "", label: t("admin.radm.allTypes") },
            ...CLAIM_TYPES.map((c) => ({ value: c, label: claimTypeLabel(c) })),
          ]}
        />
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="mr-2 size-4" aria-hidden />
          {t("admin.radm.download")}
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {t(BASIS_HINT[basis])}
      </p>

      {/* ── What it adds up to ─────────────────────────────────────────────── */}
      <StateBoundary
        loading={summary.isPending}
        error={summary.error}
        onRetry={() => void summary.refetch()}
      >
        {s === undefined || s === null ? null : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MoneyTile label={t("admin.radm.tile.claimed")} paise={s.claimed_paise}
                caption={t("admin.radm.tile.claimedCaption", {
                  n: formatNumber(s.claims), people: formatNumber(s.employees),
                })} />
              <MoneyTile label={t("admin.radm.tile.approved")} paise={s.approved_paise}
                caption={t("admin.radm.tile.approvedCaption", { n: formatNumber(s.approved_count) })} />
              <MoneyTile label={t("admin.radm.tile.paid")} paise={s.paid_paise}
                caption={t("admin.radm.tile.paidCaption", { n: formatNumber(s.paid_count) })} />
              {/*
                THE ONE TO READ FIRST. Approved and unpaid — money the venue owes. Toned as a
                warning when it is non-zero because it is a debt, not a statistic.
              */}
              <MoneyTile label={t("admin.radm.tile.outstanding")} paise={s.outstanding_paise}
                caption={t("admin.radm.tile.outstandingCaption", { n: formatNumber(s.unrouted_count) })}
                tone={s.outstanding_paise > 0 ? "warn" : "plain"} />
            </div>

            {/*
              The three states the venue named, plus refusals. These FILTER IN PLACE rather
              than navigating: `CountTile` exists for drill-through to another screen and
              demands a route and its own count query, which would mean a second definition of
              each band. The slice predicates already live in `CLAIM_SLICE_FILTERS`, and the
              table below re-reads with them.
            */}
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/*
                The UNSCOPED count, deliberately. This tile answers "what is waiting on me",
                which the period must not be able to reduce to zero.
              */}
              <StateTile label={t("admin.radm.count.pending")} value={s.pending_anywhere}
                active={queueOnly} onClick={() => setParam("slice", "awaiting")}
                note={t("admin.radm.count.pendingNote")} />
              <StateTile label={t("admin.radm.count.processed")} value={s.approved_count}
                active={slice === "unrouted"} onClick={() => setParam("slice", "unrouted")} />
              <StateTile label={t("admin.radm.count.done")} value={s.paid_count}
                active={slice === "paid"} onClick={() => setParam("slice", "paid")} />
              <StateTile label={t("admin.radm.count.rejected")} value={s.rejected_count}
                active={false} onClick={() => setParam("slice", "")} />
            </div>

            {/*
              Stated only when it is non-zero. `period_to` is nullable and nothing forces it, so
              a claim can exist that no month-by-expense-period total can legitimately include.
              Saying so is the difference between a total that is narrow and one that is wrong.
            */}
            {/*
              THE THING THAT WAS SILENT. Pending work outside the chosen period used to make
              the tile read 0 with nothing to explain it. Now it is stated, with the money, and
              one click shows it.
            */}
            {!queueOnly && s.pending_anywhere > s.pending_count ? (
              <div className="mt-3">
                <Notice tone="warning">
                  {t("admin.radm.pendingOutside", {
                    n: formatNumber(s.pending_anywhere - s.pending_count),
                    total: formatNumber(s.pending_anywhere),
                  })}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setParam("slice", "awaiting")}
                  >
                    {t("admin.radm.showQueue")}
                  </button>
                </Notice>
              </div>
            ) : null}

            {basis === "period" && s.undated_count > 0 ? (
              <div className="mt-3">
                <Notice tone="warning">
                  {t("admin.radm.undated", { n: formatNumber(s.undated_count) })}
                </Notice>
              </div>
            ) : null}

            {(byType.data ?? []).length > 0 ? (
              <div className="mt-4 rounded-lg border bg-card p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("admin.radm.byType")}
                </p>
                <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
                  {(byType.data ?? []).map((b) => (
                    <li key={b.claim_type} className="text-xs">
                      <span className="text-muted-foreground">{claimTypeLabel(b.claim_type)}</span>{" "}
                      <Money paise={b.claimed_paise} className="font-medium" />
                      <span className="text-muted-foreground">
                        {" "}
                        ({formatNumber(b.claims)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </StateBoundary>

      {/* ── Every claim ────────────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-sm font-semibold">
            {queueOnly ? t("admin.radm.queueTitle") : t("admin.radm.tableTitle")}
          </h2>
          {slice !== null ? (
            <Button variant="ghost" size="sm" onClick={() => setParam("slice", "")}>
              {t("admin.radm.clearSlice")}
            </Button>
          ) : null}
        </div>
        <StateBoundary
          loading={claims.isPending}
          error={claims.error}
          onRetry={() => void claims.refetch()}
          partialError={labels.error ?? targets.error ?? evidence.error}
          partialLabel={t("admin.radm.partial")}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Receipt}
              title={t("admin.radm.empty.title")}
              hint={t("admin.radm.empty.hint")}
            />
          }
        >
          {/*
            `total.data` is the server's count over the SAME filters, shown beside the table
            rather than passed to it: `DataGrid` paginates the rows it was given, and handing
            it a larger total would make it claim pages it does not have.
          */}
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={50} />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin.radm.rowCount", {
              shown: formatNumber(rows.length),
              total: formatNumber(total.data ?? rows.length),
            })}
          </p>
        </StateBoundary>
      </section>

      <ClaimEvidenceSheet
        claim={evidenceFor}
        lines={evidenceFor === null ? [] : (byClaim?.get(evidenceFor.id) ?? [])}
        employeeName={
          evidenceFor === null ? null : (labelMap?.get(evidenceFor.employee_id)?.name ?? null)
        }
        onOpenChange={(open) => {
          if (!open) setEvidenceFor(null);
        }}
      />

      <ReasonDialog
        open={target !== null}
        title={
          target?.decision === "reject"
            ? t("admin.radm.dialog.reject", { number: target?.row.claim_number ?? "" })
            : t("admin.radm.dialog.approve", { number: target?.row.claim_number ?? "" })
        }
        confirmLabel={
          target?.decision === "reject" ? t("admin.radm.reject") : t("admin.radm.approve")
        }
        minLength={decide.minReasonLength}
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onCancel={() => setTarget(null)}
        onConfirm={(reason) => {
          if (target === null) return;
          const decidable = targetMap?.get(target.row.id);
          if (decidable === undefined) return;
          decide.save(
            {
              claimId: target.row.id,
              claimNumber: target.row.claim_number,
              approvalRequestId: decidable.approvalRequestId,
              requestNumber: decidable.requestNumber,
              decision: target.decision,
            },
            reason,
          );
          setTarget(null);
        }}
      />
    </div>
  );
}

/**
 * A state count that filters the table below it.
 *
 * A button, not a link: the number and the rows it describes stay on one screen, so an
 * administrator can see "12 pending" and the twelve without losing the period they chose.
 */
function StateTile({
  label,
  value,
  active,
  onClick,
  note,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  /** One line under the number, for a tile whose figure is not the period's. */
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent",
        active && "border-primary ring-1 ring-primary",
      )}
    >
      <span className="block text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="num mt-0.5 block text-2xl font-semibold tabular-nums">
        {formatNumber(value)}
      </span>
      {note !== undefined ? (
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{note}</span>
      ) : null}
    </button>
  );
}

/** A money tile. Its own component so the four read identically. */
function MoneyTile({
  label,
  paise,
  caption,
  tone = "plain",
}: {
  label: string;
  paise: number;
  caption: string;
  tone?: "plain" | "warn";
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-3", tone === "warn" && "border-warning/50")}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold", tone === "warn" && "text-warning")}>
        <Money paise={paise} />
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

export default ReimbursementAdminPage;
