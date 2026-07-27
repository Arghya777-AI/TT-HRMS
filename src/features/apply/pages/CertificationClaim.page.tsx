/**
 * E-10.8 · /me/apply/certification — "Claim a certification from the approved
 * catalogue."
 *
 * There is no approved catalogue, and there is no certification request. This
 * screen exists to say exactly which pieces are missing, and it establishes the
 * first of them by READING rather than asserting: it asks
 * `request_types` for the code `CERTIFICATION` and renders the `null`.
 *
 * The full list of what a migration would have to add, from the recon:
 *
 *  1. A `request_types` row. 046 §2 seeds 18 codes (WEB_LOGIN, LEAVE,
 *     ATT_REGULARIZATION, COMP_OFF, IT_DECLARATION, PAYSLIP_REQUEST,
 *     RESIGNATION, TRAVEL_REQUISITION, LOCAL_CLAIM, PROFILE_CHANGE, BANK_CHANGE,
 *     SHIFT_SWAP, OT_PREAPPROVAL, ASSET_REQUEST, DOCUMENT_REQUEST,
 *     ADVANCE_REQUEST, SALARY_REVISION, FACE_ENROLMENT). None is a
 *     certification reimbursement.
 *  2. A detail table for it. `ck_request_types__detail_table` (029) admits
 *     sixteen table names and none of them is a certification claim, so even a
 *     new `request_types` row could not be inserted without altering that CHECK.
 *  3. An `approval_chains` row with levels, or `create_approval_request` raises
 *     `no approval chain matches request type %`.
 *  4. The catalogue itself — the list of certifications the venue will pay for,
 *     with whatever it will pay. No table in the schema holds one;
 *     `employee_qualifications.qualification_type` has a `'certification'` value
 *     (009), but that records what someone already holds, not what HR funds.
 *  5. A claim head to spend it against. `ck_rc__claim_type` (024) admits nine
 *     heads — shown below — and none is training or certification, so this
 *     cannot ride on `reimbursement_claims` either without a migration.
 *
 * The one honest thing an employee can do today is a local claim under `misc`,
 * and that is offered as an action rather than described in a paragraph.
 *
 * @route /me/apply/certification
 */
import { Link } from "react-router-dom";
import { GraduationCap, LifeBuoy, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";
import { REQUEST_CODE_CERTIFICATION } from "../api/apply-requests.api";
import { claimTypeValues, type ClaimType } from "../api/claim-submit.api";
import { useRequestTypeByCode, useRequestTypes } from "../hooks/useApply";

/** The same nine heads the claim screen offers, in the same words. */
const CLAIM_HEAD_LABEL: Readonly<Record<ClaimType, string>> = {
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

export default function CertificationClaimPage() {
  /** Deliberately expected to be null — that IS the finding. */
  const type = useRequestTypeByCode(REQUEST_CODE_CERTIFICATION);
  const liveTypes = useRequestTypes();

  return (
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
          {type.data === null || type.data === undefined ? (
            <Notice tone="error">
              <p className="font-medium">{t("apply.cert.gap.title")}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>{t("apply.cert.gap.type")}</li>
                <li>{t("apply.cert.gap.detail")}</li>
                <li>{t("apply.cert.gap.chain")}</li>
                <li>{t("apply.cert.gap.catalogue")}</li>
                <li>{t("apply.cert.gap.head")}</li>
              </ul>
            </Notice>
          ) : (
            // If a migration ever seeds the type, this screen must not keep
            // saying it is missing — it says so, and refuses to guess the form.
            <Notice tone="warning">
              <p className="font-medium">{t("apply.cert.appeared.title", { name: type.data.name })}</p>
              <p className="mt-1">{t("apply.cert.appeared.hint")}</p>
            </Notice>
          )}
        </StateBoundary>

        <EmptyState
          icon={Wallet}
          title={t("apply.cert.alt.title")}
          hint={t("apply.cert.alt.hint")}
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

        {/* ── The heads that DO exist, so "none of these" is checkable ────── */}
        <section aria-labelledby="cert-heads">
          <h2 id="cert-heads" className="font-display text-lg font-semibold">
            {t("apply.cert.heads.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.cert.heads.hint")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {claimTypeValues.map((value) => (
              <li key={value}>
                <Badge variant="neutral">{CLAIM_HEAD_LABEL[value]}</Badge>
              </li>
            ))}
          </ul>
        </section>

        {/* ── The request types HR has actually switched on ───────────────── */}
        <section aria-labelledby="cert-types">
          <h2 id="cert-types" className="font-display text-lg font-semibold">
            {t("apply.cert.types.title")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("apply.cert.types.hint")}</p>
          <StateBoundary
            loading={liveTypes.isLoading}
            error={liveTypes.error ?? undefined}
            onRetry={() => void liveTypes.refetch()}
            isEmpty={liveTypes.data !== undefined && liveTypes.data.length === 0}
            empty={
              <EmptyState
                icon={GraduationCap}
                title={t("apply.tiles.empty.title")}
                hint={t("apply.tiles.empty.hint")}
              />
            }
            skeletonRows={1}
          >
            <ul className="flex flex-wrap gap-1.5">
              {(liveTypes.data ?? []).map((row) => (
                <li key={row.id}>
                  <Badge variant="outline">{row.name}</Badge>
                </li>
              ))}
            </ul>
          </StateBoundary>
        </section>
      </div>
    </div>
  );
}
