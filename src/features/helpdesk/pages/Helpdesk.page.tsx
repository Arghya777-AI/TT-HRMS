/**
 * E-14 · /me/helpdesk — Help Desk.
 *
 * ── WHAT CHANGED, AND WHAT DID NOT ───────────────────────────────────────────
 *
 * This page used to render nothing but an honest gap notice: spec-employee §5
 * E-14 asks for a ticket queue against HR, Payroll, Stores and IT with a
 * service-level clock, and `public.helpdesk_tickets` does not exist. That is
 * still true. `grep -rn helpdesk supabase/migrations/` still returns nothing —
 * no ticket table, no SLA table, no ticket-comment table — so the ticket queue
 * is still described rather than faked.
 *
 * What DID land is the one thing people actually walked to HR's desk for:
 * `document_requests` (migration 041000) with two request types pointed at it,
 * `DOCUMENT_REQUEST` and `PAYSLIP_REQUEST`, and both routed here by
 * `CODE_TO_PATH`. So the page now carries a real form for that, and keeps the
 * gap notice for the part that is genuinely still missing. A page that says
 * "nothing here works" while a table sits unused underneath it is its own kind
 * of lie.
 *
 * ── WHAT THE SERVER CHECKS, SO THIS DOES NOT PRETEND TO ──────────────────────
 *
 * `ck_dr__payslip_needs_period` — a payslip without a month is a payslip nobody
 * can issue. `trg_dr__period` refuses a period that has not happened yet.
 * `ck_dr__other_needs_note` requires ten characters when the kind is 'other'.
 * The blockers below mirror those three so the refusal arrives before the round
 * trip, but the database is what enforces them.
 *
 * @route /me/helpdesk
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, FileText, LifeBuoy, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Notice } from "@/features/admin/components/Notice";
import { mutationUserMessage } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import { type MessageKey, t } from "@/shared/i18n/en";
import { documentKindValues, type DocumentKind } from "@/features/apply/api/simple-requests.api";
import { useSubmitDocumentRequest } from "@/features/apply/hooks/useApply";

/** Kinds that cover a stretch of time rather than a fact about today. */
const PERIODIC_KINDS: readonly DocumentKind[] = ["payslip", "salary_certificate", "form16"];

export default function HelpdeskPage() {
  const today = nowIstDate();
  const [kind, setKind] = useState<DocumentKind>("payslip");
  const [addressedTo, setAddressedTo] = useState("");
  const [note, setNote] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const send = useSubmitDocumentRequest();

  const periodic = PERIODIC_KINDS.includes(kind);

  const blockers: string[] = [];
  if (note.trim().length < 10) blockers.push(t("helpdesk.doc.blocked.note"));
  if (kind === "payslip" && periodFrom === "") blockers.push(t("helpdesk.doc.blocked.period"));
  if (periodFrom !== "" && periodFrom > today) blockers.push(t("helpdesk.doc.blocked.future"));
  if (periodTo !== "" && periodTo > today) blockers.push(t("helpdesk.doc.blocked.future"));
  if (periodFrom !== "" && periodTo !== "" && periodTo < periodFrom) {
    blockers.push(t("helpdesk.doc.blocked.order"));
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={t("helpdesk.title")}
        subtitle={t("helpdesk.subtitle")}
      />

      {sent !== null ? (
        <div className="mt-4"><Notice tone="success">{t("helpdesk.doc.done")}</Notice></div>
      ) : null}

      <section className="mt-4 rounded-lg border bg-card p-4" aria-labelledby="dr-form">
        <h2 id="dr-form" className="flex items-center gap-2 font-display text-lg font-semibold">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t("helpdesk.doc.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.doc.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="dr-kind">{t("helpdesk.doc.kind")}</Label>
            <select
              id="dr-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {documentKindValues.map((v) => (
                <option key={v} value={v}>{t(`helpdesk.doc.kind.${v}` as MessageKey)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="dr-to">{t("helpdesk.doc.addressedTo")}</Label>
            <Input
              id="dr-to"
              className="mt-1.5 h-11"
              maxLength={200}
              value={addressedTo}
              onChange={(e) => setAddressedTo(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("helpdesk.doc.addressedTo.hint")}</p>
          </div>

          {/*
            Shown only for the kinds that cover a period. An address proof has no
            month, and a date box on it is a box people fill in wrongly.
          */}
          {periodic ? (
            <>
              <div>
                <Label htmlFor="dr-pf">{t("helpdesk.doc.periodFrom")}</Label>
                <Input
                  id="dr-pf"
                  type="date"
                  max={today}
                  className="mt-1.5 h-11"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="dr-pt">{t("helpdesk.doc.periodTo")}</Label>
                <Input
                  id="dr-pt"
                  type="date"
                  max={today}
                  min={periodFrom === "" ? undefined : periodFrom}
                  className="mt-1.5 h-11"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-3">
          <Label htmlFor="dr-note">{t("helpdesk.doc.note")}</Label>
          <textarea
            id="dr-note"
            rows={3}
            maxLength={1000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {send.isError ? (
          <div className="mt-3"><Notice tone="error">{mutationUserMessage(send.error)}</Notice></div>
        ) : null}

        {blockers.length > 0 ? (
          <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">{t("helpdesk.doc.blocked.title")}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>
        ) : null}

        <Button
          className="mt-4 w-full"
          disabled={blockers.length > 0 || send.isPending}
          onClick={() => {
            if (blockers.length > 0) return;
            send.mutate(
              {
                documentKind: kind,
                addressedTo,
                note,
                /*
                  Empty means "not asked for", which is NULL — not the empty
                  string, which `date` would reject, and not today, which would
                  silently answer a question the employee did not answer.
                */
                periodFrom: periodic && periodFrom !== "" ? periodFrom : null,
                periodTo: periodic && periodTo !== "" ? periodTo : null,
              },
              { onSuccess: (r) => { setSent(r.requestId); setNote(""); } },
            );
          }}
        >
          {send.isPending ? t("helpdesk.doc.sending") : t("helpdesk.doc.send")}
        </Button>

        <p className="mt-3 text-xs text-muted-foreground">{t("helpdesk.doc.track")}</p>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.whenReady.title")}</CardTitle>
            <CardDescription>{t("helpdesk.whenReady.hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Notice tone="warning">{t("helpdesk.gap.notice")}</Notice>
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
