/**
 * E-08.4 · `/me/payslips/:period` — the payslip viewer. `:period` is 'YYYY-MM',
 * which is exactly `pay_periods.code`, so the URL is the period and nothing has
 * to be looked up to build a link.
 *
 * The three things this screen is careful about:
 *
 *  1. **Employer contributions sit OUTSIDE the net arithmetic.** Employer PF/ESI
 *     is part of CTC and is *not* taken from the employee's pay. Rendering it in
 *     the same column as deductions is how staff conclude they were charged for
 *     it. Here net pay is stated as A − B, with employer contributions in their
 *     own section below, labelled (C), and CTC for the period as A + C.
 *  2. **The attendance block is not a second opinion.** It calls
 *     `useAttendancePeriodSummary` — the attendance screen's own hook, its own
 *     query key, therefore the same cached row from
 *     `f_attendance_period_summary`. Not a similar view, not a re-aggregation:
 *     the same row. And when the payslip's stamped `paid_days` differs from that
 *     row, the screen says so out loud instead of showing two numbers and
 *     letting the reader find the contradiction (spec-screens DR: a tile and its
 *     own detail can never disagree).
 *  3. **Net pay in words comes from the server** (`payslips.net_pay_words`,
 *     stamped by `payslip-publish`). A browser-generated words form would be a
 *     second source of truth for a figure printed on a legal document.
 *
 * @route /me/payslips/:period
 */
import { useState, type ReactNode } from "react";
import { ArrowLeft, Banknote, Building2, Clock, Download, FileText, LifeBuoy, TriangleAlert } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import {
  fmtCivilDate,
  fmtCivilMonth,
  fmtDurationHm,
  civilDayOffset,
  isIstMonthKey,
  istMonthRange,
  nowIstDate,
} from "@/lib/datetime";
import { dash, formatDays, formatDaysFixed } from "@/lib/format";
// The attendance domain's own hook, on purpose: same key, same cached row from
// f_attendance_period_summary as `/me/attendance` shows for this month.
import { useAttendancePeriodSummary } from "@/features/attendance/hooks/useAttendance";
import {
  useMyEmployeeRef,
  useMyPayoutAccount,
  useMyStatutoryMasked,
  usePayslipByPeriod,
  usePayslipIssuer,
  usePayslipPdf,
} from "../hooks/usePay";
import {
  lineKindLabel,
  linesOfKind,
  OTHER_LINE_KINDS,
  paymentModeLabel,
  paymentStatusChipMap,
  payslipHeader,
} from "../display";
import { useIdentityGate } from "../identity";
import { useAmountReveal } from "../reveal";
import { RevealNote, ShowAmounts } from "../components/ShowAmounts";
import { PayslipLineTable } from "../components/PayslipLineTable";
import type { PayslipLineRow } from "../api/pay.api";

/** How long after pay date a payslip query can still be raised (spec E-08). */
const QUERY_WINDOW_DAYS = 30;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export default function PayslipViewerPage() {
  const { period = "" } = useParams<{ period: string }>();
  const reveal = useAmountReveal();
  const identity = useIdentityGate();
  const masked = !reveal.revealed;
  const validPeriod = isIstMonthKey(period);

  const payslip = usePayslipByPeriod(validPeriod ? period : undefined);
  const rows = payslip.data ?? [];
  const header = payslipHeader(rows);

  // Secondary reads — a failure here degrades the page, it does not break it.
  const issuer = usePayslipIssuer();
  const employee = useMyEmployeeRef();
  const statutory = useMyStatutoryMasked();
  const account = useMyPayoutAccount();

  // THE attendance row. Same hook, same key, same row as /me/attendance.
  const range = validPeriod ? istMonthRange(period) : { from: nowIstDate(), to: nowIstDate() };
  const attendance = useAttendancePeriodSummary(validPeriod ? period : "", range);

  const [wantPdf, setWantPdf] = useState(false);
  const pdf = usePayslipPdf(header?.pdf_document_id ?? null, wantPdf);

  if (!validPeriod) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Banknote} title={t("pay.viewer.titleUnknown")} />
        <EmptyState
          icon={Banknote}
          title={t("pay.viewer.badPeriod.title")}
          hint={t("pay.viewer.badPeriod.hint")}
          action={
            <Link
              to="/me/payslips"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("pay.viewer.back")}
            </Link>
          }
        />
      </div>
    );
  }

  const earnings = linesOfKind(rows, "earning");
  const deductions = linesOfKind(rows, "deduction");
  const employerLines = linesOfKind(rows, "employer_contribution");
  const otherLines: PayslipLineRow[] = OTHER_LINE_KINDS.flatMap((kind) => linesOfKind(rows, kind));

  const summary = attendance.data ?? null;
  /**
   * Both figures are server-stamped `SUM(day_fraction_paid)` over the same
   * period — a difference means the payroll run and the attendance engine
   * disagree, which is a data-integrity event, not a rounding artefact.
   */
  const paidDaysDisagree =
    header !== null && summary !== null && Math.abs(header.paid_days - summary.paid_days) > 0.001;

  const queryBaseDate = header?.pay_date ?? header?.period_end ?? null;
  const queryWindowOpen =
    queryBaseDate === null ? true : civilDayOffset(queryBaseDate, nowIstDate()) <= QUERY_WINDOW_DAYS;
  const helpdeskHref =
    header === null
      ? "/me/helpdesk"
      : `/me/helpdesk?category=payroll&related_type=payslip&related_id=${header.payslip_id}`;

  const mastheadPartial = issuer.error ?? employee.error ?? statutory.error ?? account.error;

  return (
    <div className="space-y-6">
      <Link
        to="/me/payslips"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("pay.viewer.back")}
      </Link>

      <PageHeader
        icon={Banknote}
        title={t("pay.viewer.title", { period: fmtCivilMonth(period) })}
        {...(header === null
          ? {}
          : { subtitle: t("pay.viewer.subtitle", { number: header.payslip_number }) })}
        actions={<ShowAmounts reveal={reveal} />}
      />
      <RevealNote reveal={reveal} />

      <StateBoundary
        loading={identity.resolving || payslip.isPending}
        error={identity.error ?? payslip.error}
        onRetry={() => void payslip.refetch()}
        isEmpty={header === null}
        skeletonRows={5}
        empty={
          <EmptyState
            icon={Banknote}
            title={t("pay.viewer.notFound.title", { period: fmtCivilMonth(period) })}
            hint={t("pay.viewer.notFound.hint")}
            action={
              <Link
                to="/me/payslips"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("pay.viewer.notFound.action")}
              </Link>
            }
          />
        }
      >
        {header !== null ? (
          <div className="space-y-6">
            {header.is_reversed ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                role="status"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <span>{t("pay.viewer.reversed.hint")}</span>
              </div>
            ) : null}

            {/* ------------------------------------------------------ masthead */}
            <section className="rounded-lg border bg-card p-4">
              {mastheadPartial !== undefined && mastheadPartial !== null ? (
                <div
                  className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
                  role="status"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <span>{t("pay.viewer.masthead.partial")}</span>
                </div>
              ) : null}

              <div className="flex items-start gap-3">
                <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <p className="font-display text-base font-semibold">
                    {dash(issuer.data?.legal_name)}
                  </p>
                  <p className="text-sm text-muted-foreground">{dash(issuer.data?.trade_name)}</p>
                </div>
              </div>

              <Separator className="my-4" />

              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label={t("pay.viewer.employee")}>
                  <span className="font-medium">{dash(header.display_name)}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {dash(header.employee_code)}
                  </span>
                </Fact>
                <Fact label={t("pay.viewer.role")}>
                  {dash(header.designation_name)}
                  <span className="block text-xs text-muted-foreground">
                    {dash(header.department_name)}
                  </span>
                </Fact>
                <Fact label={t("pay.viewer.location")}>{dash(employee.data?.location_name)}</Fact>
                <Fact label={t("pay.viewer.doj")}>{fmtCivilDate(employee.data?.date_of_join)}</Fact>

                <Fact label={t("pay.viewer.period")}>
                  {t("pay.list.window", {
                    from: fmtCivilDate(header.period_start),
                    to: fmtCivilDate(header.period_end),
                  })}
                  <span className="block text-xs text-muted-foreground">
                    {t("pay.viewer.periodDays", { days: header.period_days })}
                  </span>
                </Fact>
                <Fact label={t("pay.viewer.payDate")}>{fmtCivilDate(header.pay_date)}</Fact>
                <Fact label={t("pay.viewer.paymentState")}>
                  <StatusChip
                    status={header.is_reversed ? "reversed" : header.payment_status ?? "pending"}
                    map={paymentStatusChipMap()}
                  />
                  <span className="block text-xs text-muted-foreground">
                    {header.paid_on === null
                      ? t("pay.viewer.notPaidYet")
                      : t("pay.viewer.paidOn", { date: fmtCivilDate(header.paid_on) })}
                  </span>
                </Fact>
                <Fact label={t("pay.viewer.mode")}>
                  {paymentModeLabel(header.payment_mode)}
                  <span className="block font-mono text-xs text-muted-foreground">
                    {dash(header.payment_reference)}
                  </span>
                </Fact>
              </dl>

              <Separator className="my-4" />

              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label={t("pay.viewer.account")}>
                  {account.data === null || account.data === undefined ? (
                    t("common.empty")
                  ) : (
                    <>
                      <span className="font-mono">
                        {dash(account.data.account_number_last4, (v) => `••••••${v}`)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {dash(account.data.bank_name)}
                      </span>
                    </>
                  )}
                </Fact>
                {/* Already masked by the VIEW (`util.mask_tail`); the full numbers
                    have no client read path at all, so there is deliberately no
                    reveal control here — and they render as monospace text, never
                    as numbers (DR-16: `1.0202E+11`). */}
                <Fact label={t("pay.viewer.pan")}>
                  <span className="font-mono">{dash(statutory.data?.pan_masked)}</span>
                </Fact>
                <Fact label={t("pay.viewer.uan")}>
                  <span className="font-mono">{dash(statutory.data?.uan_masked)}</span>
                </Fact>
                <Fact label={t("pay.viewer.pf")}>
                  <span className="font-mono">{dash(statutory.data?.pf_number_masked)}</span>
                </Fact>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">{t("pay.viewer.statutory.note")}</p>
            </section>

            {/* ------------------------------------------------------ earnings */}
            <PayslipLineTable
              heading={t("pay.viewer.earnings")}
              note={t("pay.viewer.earnings.note")}
              lines={earnings}
              masked={masked}
              total={{ label: t("pay.viewer.gross"), paise: header.gross_earnings_paise }}
              emptyHint={t("pay.viewer.lines.empty", { kind: lineKindLabel("earning") })}
            />

            {/* ---------------------------------------------------- deductions */}
            <PayslipLineTable
              heading={t("pay.viewer.deductions")}
              note={t("pay.viewer.deductions.note")}
              lines={deductions}
              masked={masked}
              total={{
                label: t("pay.viewer.totalDeductions"),
                paise: header.total_deductions_paise,
              }}
              emptyHint={t("pay.viewer.lines.empty", { kind: lineKindLabel("deduction") })}
            />

            {/* ------------------------------------------------------- net pay */}
            <section className="rounded-lg border-2 border-primary/30 bg-card p-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <Fact label={t("pay.viewer.gross")}>
                  <Money paise={header.gross_earnings_paise} masked={masked} />
                </Fact>
                <Fact label={t("pay.viewer.totalDeductions")}>
                  <Money paise={header.total_deductions_paise} masked={masked} />
                </Fact>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("pay.viewer.net")}
                  </dt>
                  <dd className="num mt-1 font-display text-2xl font-semibold">
                    <Money paise={header.net_pay_paise} masked={masked} />
                  </dd>
                </div>
              </dl>
              <Separator className="my-3" />
              <p className="text-sm">
                <span className="text-muted-foreground">{t("pay.viewer.netWords")}: </span>
                {header.net_pay_words === null ? (
                  <span className="text-muted-foreground">{t("pay.viewer.netWords.missing")}</span>
                ) : masked ? (
                  <span className="text-muted-foreground">{t("pay.viewer.netWords.masked")}</span>
                ) : (
                  <span className="font-medium">{header.net_pay_words}</span>
                )}
              </p>
            </section>

            {/* ------------------------------------------- employer, outside net */}
            <PayslipLineTable
              heading={t("pay.viewer.employer")}
              note={t("pay.viewer.employer.note")}
              lines={employerLines}
              masked={masked}
              total={{
                label: t("pay.viewer.employerTotal"),
                paise: header.employer_contributions_paise,
              }}
              emptyHint={t("pay.viewer.lines.empty", {
                kind: lineKindLabel("employer_contribution"),
              })}
            />
            <div className="rounded-lg border bg-muted/40 p-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                <Fact label={t("pay.viewer.employerTotal")}>
                  <Money paise={header.employer_contributions_paise} masked={masked} />
                </Fact>
                <Fact label={t("pay.viewer.ctc")}>
                  <Money paise={header.total_ctc_for_period_paise} masked={masked} />
                </Fact>
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">{t("pay.viewer.ctc.note")}</p>
            </div>

            {/* --------------------------------------------------- other lines */}
            {otherLines.length > 0 ? (
              <PayslipLineTable
                heading={t("pay.viewer.other")}
                note={t("pay.viewer.other.note")}
                lines={otherLines}
                masked={masked}
                emptyHint={t("pay.viewer.other.empty")}
              />
            ) : null}

            {/* ----------------------------------------------------- attendance */}
            <section>
              <div className="mb-3">
                <h2 className="font-display text-lg font-semibold">
                  {t("pay.viewer.attendance.heading")}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t("pay.viewer.attendance.note", { month: fmtCivilMonth(period) })}
                </p>
              </div>

              {paidDaysDisagree ? (
                <div
                  className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                  role="status"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  <span>
                    {t("pay.viewer.attendance.disagree", {
                      payslip: formatDaysFixed(header.paid_days),
                      attendance: formatDaysFixed(summary?.paid_days ?? null),
                    })}
                  </span>
                </div>
              ) : null}

              <StateBoundary
                loading={attendance.isPending}
                error={attendance.error}
                onRetry={() => void attendance.refetch()}
                isEmpty={summary === null}
                skeletonRows={2}
                empty={
                  <EmptyState
                    icon={Clock}
                    title={t("pay.viewer.attendance.empty.title", { month: fmtCivilMonth(period) })}
                    hint={t("pay.viewer.attendance.empty.hint")}
                  />
                }
              >
                {summary !== null ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <KpiTile
                      label={t("home.kpi.paidDays")}
                      value={formatDaysFixed(summary.paid_days)}
                      hint={t("pay.viewer.attendance.of", { total: summary.total_days })}
                      explainer={{
                        formula: t("home.kpi.paidDays.formula"),
                        numbers: t("home.kpi.paidDays.numbers", {
                          paid: formatDaysFixed(summary.paid_days),
                          total: summary.total_days,
                          from: fmtCivilDate(summary.from_date),
                          to: fmtCivilDate(summary.to_date),
                        }),
                      }}
                    />
                    <KpiTile
                      label={t("home.kpi.attended")}
                      value={formatDays(summary.present_days)}
                      hint={t("pay.viewer.attendance.halfDays", { half: formatDays(summary.half_days) })}
                      explainer={{
                        formula: t("home.kpi.attended.formula", {
                          from: fmtCivilDate(summary.from_date),
                          to: fmtCivilDate(summary.to_date),
                        }),
                        numbers: t("home.kpi.attended.numbers", {
                          present: formatDays(summary.present_days),
                          half: formatDays(summary.half_days),
                        }),
                      }}
                    />
                    <KpiTile
                      label={t("pay.viewer.attendance.leaves")}
                      value={formatDays(summary.leave_days)}
                      hint={t("pay.viewer.attendance.lop", {
                        days: formatDays(header.lop_days),
                      })}
                    />
                    <KpiTile
                      label={t("pay.viewer.attendance.offs")}
                      value={formatDays(summary.weekly_off_days)}
                      hint={t("pay.viewer.attendance.holidays", {
                        days: formatDays(summary.holiday_days),
                      })}
                    />
                    <KpiTile
                      label={t("pay.viewer.attendance.absents")}
                      value={formatDays(summary.absent_days)}
                      tone={summary.absent_days > 0 ? "danger" : "neutral"}
                      hint={t("pay.viewer.attendance.pending", {
                        days: formatDays(summary.pending_days),
                      })}
                    />
                    <KpiTile
                      label={t("pay.viewer.attendance.lateDays")}
                      value={formatDays(summary.late_days)}
                      hint={t("pay.viewer.attendance.lateDeduction", {
                        days: formatDays(summary.late_deduction_leave_days),
                      })}
                    />
                    <KpiTile
                      label={t("pay.viewer.attendance.otApproved")}
                      value={fmtDurationHm(summary.approved_overtime_minutes)}
                      hint={t("pay.viewer.attendance.otOnPayslip", {
                        duration: fmtDurationHm(header.overtime_minutes),
                      })}
                    />
                    <KpiTile
                      label={t("home.kpi.extraWork")}
                      value={fmtDurationHm(summary.extra_work_minutes)}
                      hint={t("home.kpi.extraWork.hint")}
                      explainer={{
                        formula: t("home.kpi.extraWork.formula"),
                        numbers: t("home.kpi.extraWork.numbers", {
                          duration: fmtDurationHm(summary.extra_work_minutes),
                          from: fmtCivilDate(summary.from_date),
                          to: fmtCivilDate(summary.to_date),
                        }),
                      }}
                    />
                  </div>
                ) : null}
              </StateBoundary>

              <p className="mt-3 text-xs text-muted-foreground">
                {t("pay.viewer.cutoff", {
                  from: fmtCivilDate(header.period_start),
                  to: fmtCivilDate(header.period_end),
                })}
              </p>
              <Link
                to={`/me/attendance?m=${period}`}
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                <Clock className="h-4 w-4" aria-hidden />
                {t("pay.viewer.attendance.link", { month: fmtCivilMonth(period) })}
              </Link>
            </section>

            {/* ----------------------------------------------------------- YTD */}
            <section>
              <h2 className="mb-3 font-display text-lg font-semibold">
                {t("pay.viewer.ytd.heading")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiTile
                  label={t("pay.ytd.gross")}
                  value={<Money paise={header.ytd_gross_paise} masked={masked} />}
                  hint={t("pay.viewer.ytd.hint")}
                />
                <KpiTile
                  label={t("pay.ytd.deductions")}
                  value={<Money paise={header.ytd_deductions_paise} masked={masked} />}
                  hint={t("pay.viewer.ytd.hint")}
                />
                <KpiTile
                  label={t("pay.ytd.net")}
                  value={<Money paise={header.ytd_net_paise} masked={masked} />}
                  hint={t("pay.viewer.ytd.hint")}
                />
                <KpiTile
                  label={t("pay.ytd.tds")}
                  value={<Money paise={header.ytd_tds_paise} masked={masked} />}
                  hint={t("pay.viewer.ytd.hint")}
                />
              </div>
            </section>

            {/* ------------------------------------------------------- actions */}
            <section id="pdf" className="rounded-lg border bg-card p-4">
              <h2 className="font-display text-base font-semibold">
                {t("pay.viewer.actions.heading")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("pay.viewer.pdf.note")}</p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {header.pdf_document_id === null ? (
                  <p className="text-sm text-muted-foreground">{t("pay.viewer.pdf.none")}</p>
                ) : pdf.data != null ? (
                  <a
                    href={pdf.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    {t("pay.viewer.pdf.ready", { file: pdf.data.fileName })}
                  </a>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setWantPdf(true)}
                    disabled={pdf.isFetching}
                  >
                    <FileText className="mr-1.5 h-4 w-4" aria-hidden />
                    {pdf.isFetching ? t("app.loading") : t("pay.viewer.pdf.get")}
                  </Button>
                )}

                {queryWindowOpen ? (
                  <Link
                    to={helpdeskHref}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <LifeBuoy className="h-4 w-4" aria-hidden />
                    {t("pay.viewer.query")}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {t("pay.viewer.query.closed", { days: QUERY_WINDOW_DAYS })}{" "}
                    <Link to={helpdeskHref} className="text-primary underline-offset-4 hover:underline">
                      {t("pay.viewer.query.stillLinks")}
                    </Link>
                  </span>
                )}
              </div>

              {wantPdf && pdf.error !== null ? (
                <div className="mt-3">
                  <ErrorState error={pdf.error} retry={() => void pdf.refetch()} />
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}
