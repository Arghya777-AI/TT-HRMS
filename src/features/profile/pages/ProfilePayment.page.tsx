/**
 * E-07.3 · /me/profile/payment — statutory identifiers and bank account,
 * masked, with the audited self-reveal.
 *
 * The rules this tab teaches by its behaviour (spec-employee §7.3, D-19):
 *
 *  * PAN/Aadhaar/UAN/PF/ESI and the account number arrive MASKED from
 *    `v_employee_statutory_masked` / `v_employee_bank_masked` — the browser
 *    never holds a full value until the reveal RPC hands it over, once.
 *  * Revealing your own numbers is itself an audited read: the definer function
 *    writes a data-access row with your reason. `RevealPanel` says so before
 *    the click, and the revealed values live only in component state — never in
 *    the query cache — so navigating away forgets them.
 *  * Bank changes are maker-checker (BANK_CHANGE approval, applied by payroll);
 *    the flags card explains what PF/ESI/PT applicability means in plain words.
 *
 * @route /me/profile/payment
 */
import { useState } from "react";
import { Banknote, Landmark, ShieldCheck } from "lucide-react";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { fmtCivilDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { FieldGrid, FieldRow, ProfileCard } from "../components/FieldRow";
import { RevealPanel } from "../components/RevealPanel";
import { useBankAccounts, useMyProfile, useOrgLabels, useStatutory } from "../hooks/useProfile";
import { useRevealBankAccounts, useRevealStatutory } from "../hooks/useReveal";
import type { RevealedBankAccount, RevealedStatutory } from "../api/payment.api";

export default function ProfilePaymentPage() {
  const profile = useMyProfile();
  const orgLabels = useOrgLabels();
  const statutory = useStatutory();
  const bank = useBankAccounts();

  const revealStat = useRevealStatutory();
  const revealBank = useRevealBankAccounts();

  // Revealed values live in STATE, not the query cache — leaving the tab
  // forgets them, and a re-reveal is a new audited read. That is the point.
  const [statPlain, setStatPlain] = useState<RevealedStatutory | null>(null);
  const [bankPlain, setBankPlain] = useState<readonly RevealedBankAccount[] | null>(null);

  const s = statutory.data ?? null;
  const accounts = bank.data ?? [];

  return (
    <ProfileShell
      title={t("profile.payment.title")}
      subtitle={t("profile.payment.subtitle")}
      profile={profile.data}
      orgLabels={orgLabels.data}
      loading={profile.isPending}
      error={profile.error}
      onRetry={() => void profile.refetch()}
      partialError={statutory.error ?? bank.error}
      partialLabel={t("profile.payment.partial")}
    >
      <StateBoundary
        loading={statutory.isPending || bank.isPending}
        error={null}
        onRetry={() => void statutory.refetch()}
        skeletonRows={3}
      >
        <ProfileCard
          icon={ShieldCheck}
          title={t("profile.payment.statutory.title")}
          description={t("profile.payment.statutory.hint")}
        >
          {s === null ? (
            <EmptyState
              icon={ShieldCheck}
              title={t("profile.payment.statutory.empty")}
              hint={t("profile.payment.statutory.emptyHint")}
            />
          ) : (
            <>
              <FieldGrid>
                <FieldRow
                  label={t("profile.payment.pan")}
                  value={<span className="num">{statPlain?.pan ?? dash(s.pan_masked)}</span>}
                  authority="admin_only"
                />
                <FieldRow
                  label={t("profile.payment.aadhaar")}
                  value={
                    <span className="num">{statPlain?.aadhaar_number ?? dash(s.aadhaar_masked)}</span>
                  }
                  authority="admin_only"
                />
                <FieldRow
                  label={t("profile.payment.uan")}
                  value={<span className="num">{statPlain?.uan ?? dash(s.uan_masked)}</span>}
                  authority="admin_only"
                />
                <FieldRow
                  label={t("profile.payment.pf")}
                  value={<span className="num">{statPlain?.pf_number ?? dash(s.pf_number_masked)}</span>}
                  authority="admin_only"
                  {...(s.pf_joining_date !== null
                    ? { hint: t("profile.payment.pfSince", { date: fmtCivilDate(s.pf_joining_date) }) }
                    : {})}
                />
                <FieldRow
                  label={t("profile.payment.esi")}
                  value={<span className="num">{statPlain?.esi_number ?? dash(s.esi_number_masked)}</span>}
                  authority="admin_only"
                  {...(s.esi_dispensary !== null ? { hint: s.esi_dispensary } : {})}
                />
                <FieldRow
                  label={t("profile.payment.taxRegime")}
                  value={
                    s.tax_regime === "old"
                      ? t("profile.payment.regimeOld")
                      : t("profile.payment.regimeNew")
                  }
                  authority="maker_checker"
                  hint={t("profile.payment.regimeHint")}
                />
              </FieldGrid>

              <div className="mt-4">
                <RevealPanel
                  what={t("profile.payment.statutory.what")}
                  onReveal={(reason) =>
                    revealStat.mutate({ reason }, { onSuccess: (data) => setStatPlain(data) })
                  }
                  pending={revealStat.isPending}
                  error={revealStat.error}
                  revealed={statPlain !== null}
                  onHide={() => setStatPlain(null)}
                />
              </div>

              <FieldGrid>
                <FieldRow
                  label={t("profile.payment.flags.pf")}
                  value={s.pf_applicable ? t("profile.payment.applies") : t("profile.payment.notApplies")}
                  authority="admin_only"
                  hint={t("profile.payment.flags.pfHint")}
                />
                <FieldRow
                  label={t("profile.payment.flags.esi")}
                  value={s.esi_applicable ? t("profile.payment.applies") : t("profile.payment.notApplies")}
                  authority="admin_only"
                  hint={t("profile.payment.flags.esiHint")}
                />
                <FieldRow
                  label={t("profile.payment.flags.pt")}
                  value={
                    s.professional_tax_applicable
                      ? t("profile.payment.ptState", { state: dash(s.professional_tax_state) })
                      : t("profile.payment.notApplies")
                  }
                  authority="admin_only"
                  hint={t("profile.payment.flags.ptHint")}
                />
                {s.gratuity_eligible_from !== null ? (
                  <FieldRow
                    label={t("profile.payment.flags.gratuity")}
                    value={fmtCivilDate(s.gratuity_eligible_from)}
                    authority="admin_only"
                    hint={t("profile.payment.flags.gratuityHint")}
                  />
                ) : null}
              </FieldGrid>
            </>
          )}
        </ProfileCard>

        <ProfileCard
          icon={Landmark}
          title={t("profile.payment.bank.title")}
          description={t("profile.payment.bank.hint")}
        >
          {accounts.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title={t("profile.payment.bank.empty")}
              hint={t("profile.payment.bank.emptyHint")}
            />
          ) : (
            <>
              <FieldGrid>
                {accounts.map((a) => {
                  const plain = bankPlain?.find((p) => p.id === a.id);
                  return (
                    <FieldRow
                      key={a.id}
                      label={`${a.bank_name}${a.is_active ? "" : ` — ${t("profile.payment.bank.inactive")}`}`}
                      value={
                        <span className="num">
                          {plain?.account_number ?? `••••${dash(a.account_number_last4)}`}
                          <span className="ml-2 text-muted-foreground">{a.ifsc}</span>
                        </span>
                      }
                      authority="maker_checker"
                      {...(a.is_verified && a.verification_method !== null
                        ? {
                            hint: t("profile.payment.bank.verifiedVia", {
                              method: a.verification_method.replace(/_/g, " "),
                            }),
                          }
                        : { hint: t("profile.payment.bank.unverified") })}
                    />
                  );
                })}
              </FieldGrid>

              <div className="mt-4">
                <RevealPanel
                  what={t("profile.payment.bank.what")}
                  onReveal={(reason) =>
                    revealBank.mutate({ reason }, { onSuccess: (data) => setBankPlain(data) })
                  }
                  pending={revealBank.isPending}
                  error={revealBank.error}
                  revealed={bankPlain !== null}
                  onHide={() => setBankPlain(null)}
                />
              </div>
            </>
          )}
        </ProfileCard>
      </StateBoundary>
    </ProfileShell>
  );
}
