/**
 * E-14 · /me/helpdesk — Help Desk. THE BACKING TABLE DOES NOT EXIST.
 *
 * This is an honest gap page, and it is deliberate.
 *
 * spec-employee §5 E-14 asks for a ticket queue against HR, Payroll, Stores and
 * IT, with a service-level clock per ticket. Probed on the live project
 * (xfoeudhwxlbkkwetncjb) as an employee:
 *
 *     GET /rest/v1/helpdesk_tickets  →  404 PGRST205
 *       "Could not find the table 'public.helpdesk_tickets' in the schema cache"
 *        hint: "Perhaps you meant the table 'public.request_types'"
 *
 * `grep -rn helpdesk supabase/migrations/` returns nothing: there is no ticket
 * table, no SLA table, no ticket-comment table, and therefore no read to make and
 * no write path to offer. The nearest deployed thing is the generic approval
 * workflow (`approval_requests` / `request_types`), which is a DIFFERENT object —
 * an approval has an approver and a decision, a ticket has an assignee and a
 * conversation. Rendering approval rows here under a "your tickets" heading would
 * be exactly the mislabelling DR-08/DR-09 exist to prevent, so this page renders
 * neither.
 *
 * What it does instead: names the missing table, states plainly what will work
 * once it lands, and points at the two things an employee CAN do today — raise a
 * request through /me/apply (real, backed by `approval_requests`) and read
 * policies. No fabricated tickets, no fake ticket number, no "0 open tickets"
 * tile that would imply a queue exists and is empty.
 *
 * @route /me/helpdesk
 */
import { Link } from "react-router-dom";
import { ClipboardList, LifeBuoy, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Notice } from "@/features/admin/components/Notice";
import { t } from "@/shared/i18n/en";

export default function HelpdeskPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={t("helpdesk.title")}
        subtitle={t("helpdesk.subtitle")}
      />

      <Notice tone="warning">{t("helpdesk.gap.notice")}</Notice>

      <div className="mt-4">
        <EmptyState
          icon={LifeBuoy}
          title={t("helpdesk.gap.title")}
          hint={t("helpdesk.gap.hint")}
          action={
            <Button asChild>
              <Link to="/me/apply">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.gap.applyAction")}
              </Link>
            </Button>
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.whenReady.title")}</CardTitle>
            <CardDescription>{t("helpdesk.whenReady.hint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>{t("helpdesk.whenReady.item1")}</li>
              <li>{t("helpdesk.whenReady.item2")}</li>
              <li>{t("helpdesk.whenReady.item3")}</li>
              <li>{t("helpdesk.whenReady.item4")}</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.today.title")}</CardTitle>
            <CardDescription>{t("helpdesk.today.hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/apply">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.apply")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/policies">
                <ScrollText className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.policies")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/approvals">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.approvals")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("helpdesk.gap.footnote")}</p>
    </div>
  );
}
