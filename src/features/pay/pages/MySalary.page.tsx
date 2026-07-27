/**
 * E-07 Tab 7 / E-08 · `/me/profile/salary` — the salary structure, read-only.
 *
 * This is the route where the FULL model lives (Cards A–E), which is why it is a
 * real URL rather than a tab inside a mega-page: the structure is what an
 * employee links a manager or HR to. `/me/payslips` carries the payslip list and
 * links here, so neither screen is a duplicate of the other.
 *
 * Read-only by construction: salary is `❌ admin-only write` in the field matrix
 * (spec-employee §6), so there is no edit affordance to explain away — the page
 * says who to talk to instead.
 *
 * @route /me/profile/salary
 */
import { Banknote, UserRound } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/shared/ui/PageHeader";
import { t } from "@/shared/i18n/en";
import { SalarySection } from "../components/SalarySection";
import { RevealNote, ShowAmounts } from "../components/ShowAmounts";
import { useIdentityGate } from "../identity";
import { useAmountReveal } from "../reveal";

export default function MySalaryPage() {
  const reveal = useAmountReveal();
  const identity = useIdentityGate();

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UserRound}
        title={t("pay.salary.title")}
        subtitle={t("pay.salary.subtitle")}
        actions={<ShowAmounts reveal={reveal} />}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RevealNote reveal={reveal} />
        <Link
          to="/me/payslips"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <Banknote className="h-4 w-4" aria-hidden />
          {t("pay.salary.payslipsLink")}
        </Link>
      </div>

      <SalarySection
        reveal={reveal}
        identityError={identity.error}
        identityResolving={identity.resolving}
      />

      <p className="text-xs text-muted-foreground">{t("pay.salary.readOnly")}</p>
    </div>
  );
}
