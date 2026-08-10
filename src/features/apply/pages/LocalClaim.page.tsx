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
import { Loader2, Paperclip, Receipt, Sparkles, Wallet } from "lucide-react";
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
import { type MessageKey, t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { qk } from "@/shared/api/keys";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { mutationUserMessage, shouldRetryQuery } from "@/shared/api/query";
import { REQUEST_CODE_LOCAL_CLAIM } from "../api/apply-requests.api";
import {
  claimSliceValues,
  claimTypeValues,
  countMyClaims,
  fetchMyClaimRegister,
  rupeesToPaise,
  type ClaimRow,
  type ClaimSlice,
  type ClaimType,
  type SubmittedClaim,
} from "../api/claim-submit.api";
import {
  useMyOpenRequestsOfType,
  useRequestRouting,
  useRequestTypeByCode,
  useSubmitLocalClaim,
} from "../hooks/useApply";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { useMyProfile } from "@/features/profile/hooks/useProfile";
import {
  billDateIssue,
  isReadableReceipt,
  MIME_SNIFF_BYTES,
  sniffReadableMime,
  isTravelClaim,
  readableFieldCount,
  receiptIssue,
  travelModeValues,
  travelPurposeValues,
  type TravelMode,
  type TravelPurpose,
} from "../claimPolicy";
import {
  extractClaimReceipt,
  type ExtractedReceipt,
  fetchClaimReceiptType,
  uploadClaimReceipt,
} from "../api/claim-receipt.api";
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

/** `ck_claim_lines__travel_purpose`, in the words the reference product uses. */
const PURPOSE_LABEL: Readonly<Record<TravelPurpose, string>> = {
  sales: t("claim.purpose.sales"),
  support: t("claim.purpose.support"),
  management: t("claim.purpose.management"),
};

/** `ck_claim_lines__travel_mode`. Company vehicles are their own entries. */
const MODE_LABEL: Readonly<Record<TravelMode, string>> = {
  taxi: t("claim.mode.taxi"),
  auto: t("claim.mode.auto"),
  bus: t("claim.mode.bus"),
  bike: t("claim.mode.bike"),
  car: t("claim.mode.car"),
  company_bike: t("claim.mode.company_bike"),
  company_car: t("claim.mode.company_car"),
  train: t("claim.mode.train"),
  flight: t("claim.mode.flight"),
  other: t("claim.mode.other"),
};

/**
 * The window the database enforces (`claims.max_bill_age_days`, 180 by default).
 *
 * Hard-coded here and read from settings server-side, which is a deliberate
 * asymmetry: the form's copy is a courtesy, `trg_claim_lines__bill_date` is the
 * rule. If an administrator changes the setting, the server changes with it and
 * this sentence is briefly generous — which is the safe direction to be wrong.
 */
/** Border tint per tone, the same table `Lifecycle.page.tsx` uses for its stages. */
const TONE_RING: Readonly<Record<string, string>> = {
  success: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/50",
  danger: "border-destructive/50",
  neutral: "border-border",
};

/** One entry per slice, shared by the filter card and the row's own chip. */
const SLICE_CHIP: Readonly<Record<ClaimSlice, StatusChipEntry>> = {
  awaiting_submission: { label: t("claim.slice.awaiting_submission"), tone: "neutral" },
  pending: { label: t("claim.slice.pending"), tone: "warn" },
  approved: { label: t("claim.slice.approved"), tone: "info" },
  rejected: { label: t("claim.slice.rejected"), tone: "danger" },
  paid: { label: t("claim.slice.paid"), tone: "success" },
};

const CLAIM_WINDOW_DAYS = 180;

const MIN_DESCRIPTION = 10;

function isClaimType(value: string): value is ClaimType {
  return (claimTypeValues as readonly string[]).includes(value);
}

export default function LocalClaimPage() {
  const today = nowIstDate();
  const type = useRequestTypeByCode(REQUEST_CODE_LOCAL_CLAIM);
  const routing = useRequestRouting(type.data?.id);
  const open = useMyOpenRequestsOfType(type.data?.id);
  const submit = useSubmitLocalClaim();

  const [claimType, setClaimType] = useState<ClaimType>("local_conveyance");
  const [periodFrom, setPeriodFrom] = useState<string>(today);
  const [periodTo, setPeriodTo] = useState<string>(today);
  const [amountRupees, setAmountRupees] = useState("");
  const [description, setDescription] = useState("");
  const [eventReference, setEventReference] = useState("");
  const [submitted, setSubmitted] = useState<SubmittedClaim | null>(null);

  const [travelPurpose, setTravelPurpose] = useState<TravelPurpose | "">("");
  const [travelMode, setTravelMode] = useState<TravelMode | "">("");
  const [receiptDocId, setReceiptDocId] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedReceipt | null>(null);

  const { user } = useAuth();
  const profile = useMyProfile();
  /*
    The receipt type, with every predicate of `documents__self__insert` restated
    in the query. Null means this deployment cannot accept a receipt at all, and
    the screen says so BEFORE anyone picks a file — the sequence that produced
    the Aadhaar "the database refused this document" report was a picker offering
    a type the policy would not take.
  */
  const [slice, setSlice] = useState<ClaimSlice | null>(null);
  const myEmployeeId = profile.data?.id ?? null;

  /*
    One query per tile, and the register below built from the SAME
    `myClaimFilters` — so a tile can never disagree with the rows it sits above.
    `lifecycle.api.ts` records why that rule exists (the `7 vs 8` defect): two
    "equivalent" predicates drift, and the reader believes the tile.
  */
  // `useQueries`, not a `.map` of `useQuery`: one hook call, so the rules of
  // hooks hold, and each tile still fails on its own rather than blanking the row.
  const sliceCounts = useQueries({
    queries: claimSliceValues.map((value) => ({
      queryKey: qk.apply.claimSlice(myEmployeeId ?? "none", value),
      enabled: myEmployeeId !== null,
      retry: shouldRetryQuery,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        countMyClaims(myEmployeeId ?? "", value, signal),
    })),
  });

  const register = useQuery({
    queryKey: qk.apply.claimRegister(myEmployeeId ?? "none", slice ?? "all"),
    enabled: myEmployeeId !== null,
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchMyClaimRegister(myEmployeeId ?? "", slice, signal),
  });

  const receiptType = useQuery({
    queryKey: qk.apply.claimReceiptType(),
    queryFn: ({ signal }) => fetchClaimReceiptType(signal),
    retry: false,
  });

  const paise = amountRupees.trim() === "" ? null : rupeesToPaise(amountRupees);
  const amountInvalid = amountRupees.trim() !== "" && (paise === null || paise <= 0);
  const rangeInvalid = periodTo < periodFrom;
  const futureDated = periodFrom > today || periodTo > today;
  const descriptionTooShort = description.trim().length < MIN_DESCRIPTION;
  const receiptRequired = type.data?.requires_attachment ?? false;
  const travelClaim = isTravelClaim(claimType);
  const windowIssue = billDateIssue(periodFrom, today, CLAIM_WINDOW_DAYS);
  const canAttach = receiptType.data != null;
  // No chain, no request: `create_approval_request` resolves the chain or raises.
  const noChain = routing.data !== undefined && routing.data.chains.length === 0;

  const blockers: string[] = [];
  if (paise === null || paise <= 0) blockers.push(t("apply.claim.blocked.amount"));
  if (rangeInvalid) blockers.push(t("apply.claim.blocked.range"));
  if (futureDated) blockers.push(t("apply.claim.blocked.future"));
  if (descriptionTooShort) blockers.push(t("apply.claim.blocked.description"));
  // Mirrors trg_claim_lines__bill_date. `future` is already covered by
  // `futureDated` above, so only the window is added here.
  if (windowIssue === "outside_window") {
    blockers.push(t("claim.blocked.window", { days: String(CLAIM_WINDOW_DAYS) }));
  }
  if (travelClaim && travelPurpose === "") blockers.push(t("claim.blocked.purpose"));
  if (travelClaim && travelMode === "") blockers.push(t("claim.blocked.mode"));
  // ck_claim_lines__receipt_present would refuse this line server-side; saying so
  // here saves a round trip that can only end in a refusal.
  if (receiptRequired && canAttach && receiptDocId === null) {
    blockers.push(t("claim.receipt.required"));
  }
  if (noChain) blockers.push(t("apply.claim.blocked.chain"));
  if (type.data === null) blockers.push(t("apply.type.missing"));

  const canSubmit = blockers.length === 0 && !submit.isPending;

  /**
   * Attach the bill, then offer to read it.
   *
   * The upload is the part that matters and it is never undone by a reading
   * failure: once the bytes and the row are in, the claim has its evidence. Every
   * failure below that point leaves `receiptDocId` set and simply means the
   * employee types the fields — which is exactly what they would have done
   * anyway.
   */
  async function onPickReceipt(file: File | null): Promise<void> {
    setReceiptError(null);
    setExtracted(null);
    if (file === null) {
      setReceiptDocId(null);
      setReceiptName(null);
      return;
    }
    // Size is the only refusal left — any file type may be attached.
    if (receiptIssue(file) !== null) {
      setReceiptError(t("claim.receipt.tooLarge"));
      return;
    }
    const rtype = receiptType.data;
    const companyId = profile.data?.company_id ?? null;
    const employeeId = profile.data?.id ?? null;
    if (rtype == null || companyId === null || employeeId === null || !user?.id) {
      setReceiptError(t("claim.receipt.typeMissing"));
      return;
    }

    setReceiptBusy(true);
    try {
      /*
        Ask the FILE what it is, not its name. `file.type` is inferred from the
        extension, so a PDF saved as "invoice.pdf -10-Aug-2026-11_37 AM" arrives
        with an empty type — which is how a readable bill got told it could not
        be read. Falls back to the browser's answer for anything the sniffer does
        not recognise, which is correct for a .docx or a .zip.
      */
      const head = new Uint8Array(await file.slice(0, MIME_SNIFF_BYTES).arrayBuffer());
      const mimeType = sniffReadableMime(head) ?? file.type;

      const doc = await uploadClaimReceipt({
        employeeId,
        companyId,
        profileId: user.id,
        type: rtype,
        file,
        mimeType,
        issueDate: periodFrom === "" ? null : periodFrom,
      });
      setReceiptDocId(doc.id);
      setReceiptName(file.name);

      try {
        // Attached is attached. Only images and PDFs can be READ, so anything else
      // skips the round trip rather than spending a request to be told so.
      if (!isReadableReceipt(mimeType)) {
        setReceiptError(t("claim.receipt.notReadable"));
        return;
      }
      const read = await extractClaimReceipt(doc.id);
        // An empty reading is not worth a dialog — it reads as a failure either
        // way and costs a tap to dismiss.
        if (readableFieldCount(read.fields) > 0) setExtracted(read);
        else setReceiptError(t("claim.ocr.nothing"));
      } catch {
        // Budget spent, blurred photo, model refusal — one outcome from here.
        setReceiptError(t("claim.ocr.unavailable"));
      }
    } catch (e) {
      setReceiptDocId(null);
      setReceiptName(null);
      setReceiptError(mutationUserMessage(e));
    } finally {
      setReceiptBusy(false);
    }
  }

  /** Accept what was read — never overwriting something already typed. */
  function applyExtracted(): void {
    const read = extracted;
    if (read === null) return;
    const f = read.fields;
    if (f.total_amount_rupees !== null && amountRupees.trim() === "") {
      setAmountRupees(String(f.total_amount_rupees));
    }
    if (f.bill_date !== null) {
      setPeriodFrom(f.bill_date);
      setPeriodTo(f.bill_date);
    }
    if (f.description !== null && description.trim() === "") {
      const vendor = f.vendor_name === null ? "" : `${f.vendor_name} — `;
      setDescription(`${vendor}${f.description}`);
    }
    if (f.travel_mode !== null && travelMode === "") {
      const mode = (travelModeValues as readonly string[]).includes(f.travel_mode)
        ? (f.travel_mode as TravelMode)
        : null;
      if (mode !== null) setTravelMode(mode);
    }
    setExtracted(null);
  }

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
        travelPurpose: travelClaim && travelPurpose !== "" ? travelPurpose : null,
        travelMode: travelClaim && travelMode !== "" ? travelMode : null,
        receiptDocumentId: receiptDocId,
      },
      {
        onSuccess: (result) => {
          setSubmitted(result);
          setAmountRupees("");
          setDescription("");
          setEventReference("");
          setTravelPurpose("");
          setTravelMode("");
          setReceiptDocId(null);
          setReceiptName(null);
          setExtracted(null);
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
              {/*
                THE BILL COMES FIRST.
                Asked for: "keep the option to upload and autofill button above".
                It is also the right order on its own merits — attaching the bill
                is the one action that can fill the rest of the form in, so
                offering it after the fields invites people to type everything and
                then discover they need not have.
              */}
              {/*
                The bill. This used to be a notice telling the employee there was
                no upload here and to hand the original to Finance quoting the
                claim number — true when it was written, and the reason
                `claim_lines.receipt_document_id` had never been written by
                anything since 002400. Migration 040400 seeds the document type
                that makes an employee-filed receipt legal.

                The notice survives, unchanged, for a deployment that has not run
                that migration: `receiptType` comes back null and there is
                genuinely nowhere to put the file.
              */}
              {canAttach ? (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                    {t("claim.receipt.lead")}
                  </p>
                  <Label htmlFor="claim-receipt" className="mt-2 block">
                    {t("claim.receipt.label")}
                  </Label>
                  <input
                    id="claim-receipt"
                    type="file"
                    disabled={receiptBusy}
                    onChange={(e) => void onPickReceipt(e.target.files?.[0] ?? null)}
                    className="mt-1.5 block w-full text-sm file:mr-3 file:h-9 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("claim.receipt.hint")}
                  </p>
                  {receiptBusy ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      {extracted === null && receiptDocId === null
                        ? t("claim.receipt.uploading")
                        : t("claim.ocr.reading")}
                    </p>
                  ) : null}
                  {receiptName !== null && !receiptBusy ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success">
                      <Paperclip className="h-3.5 w-3.5" aria-hidden />
                      {t("claim.receipt.attached", { name: receiptName })}
                    </p>
                  ) : null}
                  {receiptError !== null ? (
                    <p className="mt-1.5 text-xs text-muted-foreground">{receiptError}</p>
                  ) : null}
                </div>
              ) : receiptRequired ? (
                <Notice tone="warning">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Paperclip className="h-4 w-4" aria-hidden />
                    {t("apply.claim.receipt.title")}
                  </p>
                  <p className="mt-1">{t("claim.receipt.typeMissing")}</p>
                </Notice>
              ) : null}

              {/*
                What the bill said — offered, never applied on its own. The
                employee decides, and `applyExtracted` will not overwrite a box
                they have already filled in: the person who looked at the bill
                outranks the model that read it.
              */}
              {extracted !== null ? (
                <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
                  <p className="text-sm font-medium">{t("claim.ocr.title")}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t("claim.ocr.lead")}</p>
                  <dl className="mt-2 space-y-1 text-sm">
                    {(
                      [
                        ["claim.ocr.field.amount", extracted.fields.total_amount_rupees, extracted.confidence.total_amount_rupees],
                        ["claim.ocr.field.date", extracted.fields.bill_date, extracted.confidence.bill_date],
                        ["claim.ocr.field.vendor", extracted.fields.vendor_name, extracted.confidence.vendor_name],
                        ["claim.ocr.field.description", extracted.fields.description, extracted.confidence.description],
                        ["claim.ocr.field.mode", extracted.fields.travel_mode, extracted.confidence.travel_mode],
                      ] as const
                    )
                      .filter(([, value]) => value !== null && value !== "")
                      .map(([key, value, confidence]) => (
                        <div key={key} className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">{t(key)}</dt>
                          <dd className="text-right">
                            {String(value)}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {confidence >= 0.8 ? t("claim.ocr.confident") : t("claim.ocr.unsure")}
                            </span>
                          </dd>
                        </div>
                      ))}
                  </dl>
                  {extracted.notes.trim() !== "" ? (
                    <p className="mt-2 text-xs text-muted-foreground">{extracted.notes}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={applyExtracted}>
                      {t("claim.ocr.use")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setExtracted(null)}
                    >
                      {t("claim.ocr.manual")}
                    </Button>
                  </div>
                </div>
              ) : null}

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

              {/*
                Shown only for a head where a journey happened. A medical bill has
                no mode of travel, and a dropdown that must be answered anyway
                teaches people to pick anything to get past it — which is worse
                than no answer, because it looks like data. `ck_claim_lines__travel_mode`
                permits null for exactly this reason.
              */}
              {travelClaim ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="claim-purpose">{t("claim.purpose.label")}</Label>
                    <select
                      id="claim-purpose"
                      value={travelPurpose}
                      onChange={(e) => setTravelPurpose(e.target.value as TravelPurpose | "")}
                      className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">{t("claim.purpose.placeholder")}</option>
                      {travelPurposeValues.map((value) => (
                        <option key={value} value={value}>
                          {PURPOSE_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="claim-mode">{t("claim.mode.label")}</Label>
                    <select
                      id="claim-mode"
                      value={travelMode}
                      onChange={(e) => setTravelMode(e.target.value as TravelMode | "")}
                      className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">{t("claim.mode.placeholder")}</option>
                      {travelModeValues.map((value) => (
                        <option key={value} value={value}>
                          {MODE_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

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

          {/*
            FILTER BY STATUS. A button, not a link: it toggles which slice the
            register below is showing, and the tile and the rows are built from
            the same `myClaimFilters` predicate so they cannot disagree.

            A tile that cannot be read shows an em dash, never a plausible `0` —
            a zero is a claim ("you have none"), and a query that failed does not
            know that.
          */}
          <div
            className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
            role="group"
            aria-label={t("claim.filter.title")}
          >
            {claimSliceValues.map((value, i) => {
              const q = sliceCounts[i];
              const active = slice === value;
              const chip: StatusChipEntry = SLICE_CHIP[value];
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSlice(active ? null : value)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-lg border bg-card p-3 text-left transition-colors",
                    "hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    TONE_RING[chip.tone],
                    active && "ring-2 ring-primary",
                  )}
                >
                  <p className="text-xs text-muted-foreground">{chip.label}</p>
                  <p className="num mt-1 font-display text-2xl font-semibold">
                    {q === undefined || q.isPending
                      ? "…"
                      : q.error !== null
                        ? t("common.empty")
                        : formatNumber(q.data ?? 0)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`claim.slice.${value}.hint` as MessageKey)}
                  </p>
                </button>
              );
            })}
          </div>

          <StateBoundary
            loading={register.isLoading}
            error={register.error ?? undefined}
            onRetry={() => void register.refetch()}
          >
            <DataGrid
              columns={claimColumns}
              rows={register.data ?? []}
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
