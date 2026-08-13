/**
 * E-10.8 · /me/apply/certification — ask the venue to fund a certification.
 *
 * ── FIVE CLAIMS, ALL OF THEM TRUE, ALL OF THEM NOW ANSWERED ──────────────────
 *
 * This screen used to offer no form and list five reasons why. Unlike the asset
 * and tax screens — where the "missing" backend turned out to have been there all
 * along and only the client was absent — every one of these five was real:
 *
 *  1. NO REQUEST TYPE. 046 seeded eighteen codes and none was a certification.
 *  2. NO DETAIL TABLE. `ck_request_types__detail_table` admitted sixteen table
 *     names, so even inserting the type would have been refused.
 *  3. NO APPROVAL CHAIN, so `create_approval_request` would have raised.
 *  4. NO CATALOGUE. `employee_qualifications` records what somebody already
 *     HOLDS, which is not the same as what the venue will FUND.
 *  5. NO CLAIM HEAD. `ck_rc__claim_type` admits nine and none is training.
 *
 * Migration 043300 built all five. The screen still READS rather than asserts:
 * if the request type is inactive it says so and falls back, because a form that
 * cannot route is worse than no form.
 *
 * ── TWO NUMBERS, AND A CAP THAT DOES NOT BITE ────────────────────────────────
 *
 * The fee and the amount asked for are collected separately, because they differ
 * whenever the employee is part-funding a course or a cap applies — and which of
 * those is happening is exactly what an approver needs to see.
 *
 * The catalogue cap is DISPLAYED and never enforced here. It is what management
 * agreed to fund, not a limit on what may be typed: an employee who needs a
 * ₹60,000 diploma against a ₹50,000 ceiling should be able to ask and be told no
 * by a person, rather than be silently prevented by a form. Asking above the cap
 * says so on screen, in the same breath as saying it is allowed.
 *
 * ── WHAT IS STILL NOT HERE ───────────────────────────────────────────────────
 *
 * No proof upload. `proof_document_ids` exists on the row and stays empty: the
 * certificate arrives AFTER the course, which is a different moment in the
 * process from asking for the money, and building both into one form would
 * conflate a request with a settlement.
 *
 * No service commitment. `service_commitment_months` is recorded at APPROVAL by
 * whoever agrees the money — an employee cannot bind themselves to a term the
 * venue has not yet offered.
 *
 * @route /me/apply/certification
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { GraduationCap, LifeBuoy, Send, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Required } from "@/shared/ui/Required";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import {
  SubmitAttemptScope,
  SubmitBlockers,
  blockerButtonProps,
  useSubmitAttempt,
} from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { mutationUserMessage } from "@/shared/api/query";
import { formatPaise } from "@/lib/money";
import { CoverageBar } from "@/shared/ui/charts/CoverageBar";
import { SplitBar } from "@/shared/ui/charts/SplitBar";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { MessageKey } from "@/shared/i18n/en";
import { REQUEST_CODE_CERTIFICATION } from "../api/apply-requests.api";
import { rupeesAsNumber, rupeesToPaise } from "../api/claim-submit.api";
import {
  CERTIFICATION_REASON_MIN_LENGTH,
  hasOpenClaimFor,
  type CertificationClaim,
} from "../api/certification.api";
import {
  useCertificationCatalogue,
  useMyCertificationClaims,
  useRequestTypeByCode,
  useSubmitCertificationClaim,
} from "../hooks/useApply";
import { RequestRoutingCard } from "../components/RequestRoutingCard";
import { useRequestRouting } from "../hooks/useApply";

const BLOCKER_ID = "cert-blockers";

/**
 * `public.approval_status`, in the SAME words /me/apply/claim and the travel
 * screen use. Borrowed deliberately rather than reworded: three screens
 * describing one status three ways is how an employee ends up asking which of
 * them is telling the truth.
 */
const CLAIM_STATUS_MAP: Record<string, StatusChipEntry> = {
  draft: { label: t("apply.claim.status.draft"), tone: "neutral" },
  pending: { label: t("apply.claim.status.pending"), tone: "warn" },
  in_progress: { label: t("apply.claim.status.pending"), tone: "warn" },
  escalated: { label: t("apply.claim.status.pending"), tone: "warn" },
  approved: { label: t("apply.claim.status.approved"), tone: "success" },
  rejected: { label: t("apply.claim.status.rejected"), tone: "danger" },
  withdrawn: { label: t("apply.claim.status.cancelled"), tone: "neutral" },
  cancelled: { label: t("apply.claim.status.cancelled"), tone: "neutral" },
};

export default function CertificationClaimPage() {
  const type = useRequestTypeByCode(REQUEST_CODE_CERTIFICATION);
  const routing = useRequestRouting(type.data?.id);
  const catalogue = useCertificationCatalogue();
  const mine = useMyCertificationClaims();
  const send = useSubmitCertificationClaim();
  const attempt = useSubmitAttempt();

  const [catalogueId, setCatalogueId] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [fee, setFee] = useState("");
  const [ask, setAsk] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [completesOn, setCompletesOn] = useState("");
  const [reason, setReason] = useState("");

  const entries = catalogue.data ?? [];
  const chosen = entries.find((e) => e.id === catalogueId);

  const feePaise = rupeesToPaise(fee);
  const askPaise = rupeesToPaise(ask);

  /*
    Every one of these mirrors a server rule — ck_certclaim__fee,
    ck_certclaim__requested, ck_certclaim__not_more_than_fee,
    ck_certclaim__reason, ck_certclaim__dates and uq_certclaim__one_open. The
    server is what enforces them; this is only so the refusal arrives before the
    round trip rather than after it, in the same words.
  */
  const blockers: string[] = [];
  if (name.trim() === "") blockers.push(t("apply.cert.blocked.name"));
  if (feePaise === null || feePaise <= 0) blockers.push(t("apply.cert.blocked.fee"));
  if (askPaise === null || askPaise <= 0) blockers.push(t("apply.cert.blocked.ask"));
  if (feePaise !== null && askPaise !== null && askPaise > feePaise) {
    blockers.push(t("apply.cert.blocked.askOverFee"));
  }
  if (reason.trim().length < CERTIFICATION_REASON_MIN_LENGTH) {
    blockers.push(
      t("apply.cert.blocked.reason", { n: String(CERTIFICATION_REASON_MIN_LENGTH) }),
    );
  }
  if (startsOn !== "" && completesOn !== "" && completesOn < startsOn) {
    blockers.push(t("apply.cert.blocked.dates"));
  }
  if (hasOpenClaimFor(mine.data ?? [], name)) {
    blockers.push(t("apply.cert.blocked.duplicate"));
  }

  /*
    Totals across DECIDED claims only — a decision is the only moment both
    figures exist. `amount_approved_paise` is null until then, and counting a
    pending claim's ask against a null agreement would draw the queue as a
    refusal.
  */
  const decided = (mine.data ?? []).reduce(
    (acc, c) =>
      c.amount_approved_paise === null
        ? acc
        : {
            asked: acc.asked + c.amount_requested_paise,
            agreed: acc.agreed + c.amount_approved_paise,
            count: acc.count + 1,
          },
    { asked: 0, agreed: 0, count: 0 },
  );

  /* Above the cap is ALLOWED — said out loud rather than prevented. */
  const overCap =
    chosen !== undefined && askPaise !== null && askPaise > chosen.funding_cap_paise;

  const columns: DataGridColumn<CertificationClaim>[] = [
    {
      key: "certification_name",
      header: t("apply.cert.col.name"),
      render: (row) => (
        <div>
          <p className="font-medium leading-snug">{row.certification_name}</p>
          {row.issuing_body === null ? null : (
            <p className="text-xs text-muted-foreground">{row.issuing_body}</p>
          )}
        </div>
      ),
    },
    {
      key: "course_fee_paise",
      header: t("apply.cert.col.fee"),
      align: "right",
      width: "9rem",
      hideBelow: "md",
      render: (row) => formatPaise(row.course_fee_paise),
    },
    {
      key: "amount_requested_paise",
      header: t("apply.cert.col.asked"),
      align: "right",
      width: "9rem",
      render: (row) => formatPaise(row.amount_requested_paise),
    },
    {
      key: "amount_approved_paise",
      header: t("apply.cert.col.approved"),
      align: "right",
      width: "9rem",
      /* Null until somebody decides — a dash, never a zero. A zero would read as
         "they agreed to nothing", which is a decision nobody has taken yet. */
      render: (row) =>
        row.amount_approved_paise === null
          ? dash(null)
          : formatPaise(row.amount_approved_paise),
    },
    {
      key: "status",
      header: t("apply.cert.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={CLAIM_STATUS_MAP} />,
    },
    {
      key: "submitted_at",
      header: t("apply.cert.col.sent"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) =>
        row.submitted_at === null ? dash(null) : fmtDateTime(row.submitted_at),
    },
    {
      key: "reimbursed_on",
      header: t("apply.cert.col.paid"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.reimbursed_on),
    },
  ];

  /* The type is inactive or absent: no form, because nothing could route it. */
  const typeMissing = type.data === null || type.data === undefined;

  return (
    <SubmitAttemptScope attempt={attempt}>
      <div>
        <PageHeader
          icon={GraduationCap}
          title={t("apply.cert.title")}
          subtitle={t("apply.cert.subtitle")}
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link to="/me/apply">{t("apply.back")}</Link>
            </Button>
          }
        />

        <div className="space-y-6">
          <StateBoundary
            loading={type.isLoading}
            error={type.error ?? undefined}
            onRetry={() => void type.refetch()}
            skeletonRows={1}
          >
            {typeMissing ? (
              <>
                <Notice tone="warning">
                  <p className="font-medium">{t("apply.cert.absent.title")}</p>
                  <p className="mt-1">{t("apply.cert.absent.hint")}</p>
                </Notice>
                <EmptyState
                  icon={Wallet}
                  title={t("apply.cert.mine.empty.title")}
                  hint={t("apply.cert.absent.hint")}
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button asChild>
                        <Link to="/me/apply/claim">{t("apply.cert.alt.cta")}</Link>
                      </Button>
                      <Button asChild variant="outline">
                        <Link to="/me/helpdesk">
                          <LifeBuoy className="h-4 w-4" aria-hidden />
                          {t("apply.cert.alt.ticket")}
                        </Link>
                      </Button>
                    </div>
                  }
                />
              </>
            ) : (
              <>
                {/* ── The form ──────────────────────────────────────────── */}
                <section className="rounded-lg border bg-card p-4" aria-labelledby="cert-form">
                  <h2 id="cert-form" className="font-display text-lg font-semibold">
                    {t("apply.cert.form.title")}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {t("apply.cert.form.hint")}
                  </p>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Label htmlFor="cert-cat">{t("apply.cert.field.catalogue")}</Label>
                      <select
                        id="cert-cat"
                        value={catalogueId}
                        className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onChange={(e) => {
                          const next = e.target.value;
                          setCatalogueId(next);
                          /*
                            Picking from the catalogue fills the name and the
                            body, because retyping what HR has already written is
                            how two spellings of the same certification end up in
                            the register. Clearing the picker leaves whatever is
                            typed alone — it is the employee's text by then.
                          */
                          const entry = entries.find((c) => c.id === next);
                          if (entry !== undefined) {
                            setName(entry.name);
                            setBody(entry.issuing_body ?? "");
                          }
                        }}
                      >
                        <option value="">{t("apply.cert.field.catalogue.none")}</option>
                        {entries.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} — {t("apply.cert.cat.cap", { cap: formatPaise(c.funding_cap_paise) })}
                          </option>
                        ))}
                      </select>
                      {entries.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("apply.cert.field.catalogue.empty")}
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <Label htmlFor="cert-name">
                        {t("apply.cert.field.name")}
                        <Required />
                      </Label>
                      <Input
                        required
                        id="cert-name"
                        className="mt-1.5 h-11"
                        maxLength={200}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("apply.cert.field.name.hint")}
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="cert-body">{t("apply.cert.field.body")}</Label>
                      <Input
                        id="cert-body"
                        className="mt-1.5 h-11"
                        maxLength={200}
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("apply.cert.field.body.hint")}
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="cert-fee">
                        {t("apply.cert.field.fee")}
                        <Required />
                      </Label>
                      <Input
                        required
                        id="cert-fee"
                        inputMode="decimal"
                        className="mt-1.5 h-11"
                        value={fee}
                        onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("apply.cert.field.fee.hint")}
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="cert-ask">
                        {t("apply.cert.field.ask")}
                        <Required />
                      </Label>
                      <Input
                        required
                        id="cert-ask"
                        inputMode="decimal"
                        className="mt-1.5 h-11"
                        value={ask}
                        onChange={(e) => setAsk(e.target.value.replace(/[^0-9.]/g, ""))}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("apply.cert.field.ask.hint")}
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="cert-start">{t("apply.cert.field.starts")}</Label>
                      <Input
                        id="cert-start"
                        type="date"
                        className="mt-1.5 h-11"
                        value={startsOn}
                        onChange={(e) => setStartsOn(e.target.value)}
                      />
                    </div>

                    <div>
                      <Label htmlFor="cert-end">{t("apply.cert.field.completes")}</Label>
                      <Input
                        id="cert-end"
                        type="date"
                        min={startsOn === "" ? undefined : startsOn}
                        className="mt-1.5 h-11"
                        value={completesOn}
                        onChange={(e) => setCompletesOn(e.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("apply.cert.field.dates.hint")}
                      </p>
                    </div>
                  </div>

                  {/* What the venue has said about THIS certification. */}
                  {chosen === undefined ? (
                    catalogueId === "" && entries.length > 0 ? (
                      <div className="mt-3">
                        <Notice tone="info">{t("apply.cert.notListed")}</Notice>
                      </div>
                    ) : null
                  ) : (
                    <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
                      <p>
                        {t("apply.cert.cap.line", {
                          cap: formatPaise(chosen.funding_cap_paise),
                        })}
                      </p>
                      {chosen.requires_pass ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("apply.cert.cap.pass")}
                        </p>
                      ) : null}
                      {chosen.eligibility_note === null ? null : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("apply.cert.cap.eligibility", { note: chosen.eligibility_note })}
                        </p>
                      )}
                    </div>
                  )}

                  {/*
                    WHO IS PAYING FOR WHAT, while it is still being typed.
                    The fee and the ask are two boxes several fields apart, and
                    the difference between them — the part the employee would be
                    funding themselves — is the number nobody computes until the
                    money is gone. Drawn only once both are valid, because a bar
                    that redraws on every keystroke of a half-typed figure is
                    noise rather than information.
                  */}
                  {feePaise !== null && askPaise !== null && feePaise > 0 && askPaise > 0 ? (
                    <div className="mt-4 rounded-md border bg-muted/20 p-3">
                      <SplitBar
                        title={t("apply.cert.chart.split")}
                        showShare
                        height={12}
                        format={(v) => formatPaise(v)}
                        segments={[
                          {
                            key: "venue",
                            label: t("apply.cert.chart.venue"),
                            value: Math.min(askPaise, feePaise),
                            tone: "earning",
                          },
                          {
                            key: "self",
                            label: t("apply.cert.chart.self"),
                            value: Math.max(feePaise - askPaise, 0),
                            tone: "deduction",
                          },
                        ]}
                        totalCaption={
                          feePaise > askPaise
                            ? t("apply.cert.chart.shortfall", {
                                self: formatPaise(feePaise - askPaise),
                              })
                            : t("apply.cert.chart.whole")
                        }
                      />
                    </div>
                  ) : null}

                  {overCap && chosen !== undefined && askPaise !== null ? (
                    <div className="mt-3">
                      <Notice tone="warning">
                        {t("apply.cert.cap.over", {
                          ask: formatPaise(askPaise),
                          cap: formatPaise(chosen.funding_cap_paise),
                        })}
                      </Notice>
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <Label htmlFor="cert-reason">
                      {t("apply.cert.field.reason")}
                      <Required />
                    </Label>
                    <textarea
                      required
                      id="cert-reason"
                      rows={3}
                      maxLength={2000}
                      className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("apply.cert.field.reason.hint", {
                        n: String(CERTIFICATION_REASON_MIN_LENGTH),
                      })}
                    </p>
                  </div>

                  {send.isError ? (
                    <div className="mt-3">
                      <Notice tone="error">{mutationUserMessage(send.error)}</Notice>
                    </div>
                  ) : null}

                  <SubmitBlockers
                    attempt={attempt}
                    blockers={blockers}
                    id={BLOCKER_ID}
                    title={t("apply.cert.blocked.title")}
                  />

                  <Button
                    className="mt-4 w-full"
                    disabled={send.isPending}
                    {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}
                    onClick={() => {
                      if (!attempt.press(blockers)) return;
                      if (feePaise === null || askPaise === null) return;
                      const askRupees = rupeesAsNumber(ask);
                      if (askRupees === null) return;
                      send.mutate(
                        {
                          catalogueId: catalogueId === "" ? null : catalogueId,
                          certificationName: name,
                          issuingBody: body.trim() === "" ? null : body,
                          courseFeePaise: feePaise,
                          amountRequestedPaise: askPaise,
                          amountRequestedRupees: askRupees,
                          startsOn: startsOn === "" ? null : startsOn,
                          completesOn: completesOn === "" ? null : completesOn,
                          reason,
                        },
                        {
                          onSuccess: () => {
                            attempt.reset();
                            setCatalogueId("");
                            setName("");
                            setBody("");
                            setFee("");
                            setAsk("");
                            setStartsOn("");
                            setCompletesOn("");
                            setReason("");
                            confirmSubmitted(t("apply.cert.done"), {
                              detail: t("apply.cert.doneDetail"),
                            });
                          },
                        },
                      );
                    }}
                  >
                    <Send className="mr-2 size-4" aria-hidden />
                    {send.isPending ? t("apply.cert.sending") : t("apply.cert.send")}
                  </Button>
                </section>

                {/* Read from `approval_chains`, so an empty card is proof the
                    route is gone rather than a paragraph claiming it is there. */}
                <RequestRoutingCard
                  routing={routing.data}
                  missingChainMessage={t("apply.cert.gap.chain")}
                />
              </>
            )}
          </StateBoundary>

          {/* ── What the venue funds ─────────────────────────────────────── */}
          <section aria-labelledby="cert-catalogue">
            <h2 id="cert-catalogue" className="font-display text-lg font-semibold">
              {t("apply.cert.cat.title")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("apply.cert.cat.hint")}</p>
            <StateBoundary
              loading={catalogue.isLoading}
              error={catalogue.error ?? undefined}
              onRetry={() => void catalogue.refetch()}
              isEmpty={catalogue.data !== undefined && catalogue.data.length === 0}
              empty={
                <EmptyState
                  icon={GraduationCap}
                  title={t("apply.cert.cat.empty.title")}
                  hint={t("apply.cert.cat.empty.hint")}
                />
              }
              skeletonRows={2}
            >
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {entries.map((c) => (
                  <li key={c.id} className="rounded-lg border bg-card p-3">
                    <p className="font-medium leading-snug">{c.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.issuing_body === null ? c.code : `${c.issuing_body} · ${c.code}`}
                    </p>
                    <p className="num mt-2 text-sm font-semibold">
                      {t("apply.cert.cat.cap", { cap: formatPaise(c.funding_cap_paise) })}
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      <li>
                        <Badge variant="neutral">
                          {t(`apply.cert.category.${c.category}` as MessageKey)}
                        </Badge>
                      </li>
                      {c.requires_pass ? (
                        <li>
                          <Badge variant="warning">{t("apply.cert.cap.pass")}</Badge>
                        </li>
                      ) : null}
                    </ul>
                  </li>
                ))}
              </ul>
            </StateBoundary>
          </section>

          {/* ── My own claims ────────────────────────────────────────────── */}
          <section aria-labelledby="cert-mine">
            <h2 id="cert-mine" className="font-display text-lg font-semibold">
              {t("apply.cert.mine.title")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("apply.cert.mine.hint")}</p>
            {/*
              Only over DECIDED claims. Adding a pending request into "asked"
              while its approval is necessarily absent from "agreed" would draw a
              shortfall that is really just a queue — and read as a refusal
              nobody has made.
            */}
            {decided.asked > 0 ? (
              <div className="mb-4 rounded-lg border bg-card p-4">
                <CoverageBar
                  value={decided.agreed}
                  target={decided.asked}
                  title={t("apply.cert.chart.agreed")}
                  showLabel
                  height={12}
                  format={(v) => formatPaise(v)}
                  caption={t("apply.cert.chart.agreedHint", {
                    n: formatNumber(decided.count),
                  })}
                />
              </div>
            ) : null}
            <StateBoundary
              loading={mine.isLoading}
              error={mine.error ?? undefined}
              onRetry={() => void mine.refetch()}
              isEmpty={mine.data !== undefined && mine.data.length === 0}
              empty={
                <EmptyState
                  icon={Wallet}
                  title={t("apply.cert.mine.empty.title")}
                  hint={t("apply.cert.mine.empty.hint")}
                />
              }
              skeletonRows={3}
            >
              <DataGrid rows={mine.data ?? []} columns={columns} rowKey={(r) => r.id} />
            </StateBoundary>
          </section>
        </div>
      </div>
    </SubmitAttemptScope>
  );
}
