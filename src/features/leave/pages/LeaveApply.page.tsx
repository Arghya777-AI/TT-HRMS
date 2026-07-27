/**
 * E-05.4 Apply for leave `/me/leave/apply` — progressive, server-previewed.
 *
 * THE RULE THIS SCREEN EXISTS TO ENFORCE: submit is impossible until the server
 * has allocated the dates. `canSubmit` requires a preview whose signature still
 * matches the form (`type|from|to|portion`), so editing any of those four fields
 * re-locks the button and says so. The day count, the paid/unpaid split and the
 * per-date fractions are all read from the server's response — this file contains
 * no leave arithmetic at all.
 *
 * Order of the form follows the spec: type → when → allocation → details.
 *
 * @route /me/leave/apply
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarPlus, ChevronLeft, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useLeaveBalanceForType } from "../hooks/useLeave";
import {
  useLeavePreview,
  useLeaveTypeRules,
  useMyLeaveContext,
  useSubmitLeave,
} from "../hooks/useLeaveApply";
import {
  isEligibleLeaveType,
  isProbationLocked,
  type LeaveDayPortion,
  type LeavePreview,
  type LeaveTypeRule,
} from "../api/leave-apply.api";
import { AllocationTable } from "../components/AllocationTable";
import { fmtDays } from "../components/leave-vocab";

type WhenMode = "one" | "range" | "half";

const MOBILE_RE = /^[6-9]\d{9}$/;

/** The four fields the server allocation depends on. Anything else is metadata. */
function signatureOf(typeId: string, from: string, to: string, portion: LeaveDayPortion): string {
  return `${typeId}|${from}|${to}|${portion}`;
}

function SectionHeading({ step, children }: { step: number; children: string }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
        aria-hidden
      >
        {step}
      </span>
      {children}
    </h2>
  );
}

export default function LeaveApplyPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const rules = useLeaveTypeRules();
  const context = useMyLeaveContext();

  const today = nowIstDate();
  const [leaveTypeId, setLeaveTypeId] = useState<string>(params.get("type") ?? "");
  const [mode, setMode] = useState<WhenMode>("one");
  const [fromDate, setFromDate] = useState<string>(today);
  const [toDate, setToDate] = useState<string>(today);
  const [half, setHalf] = useState<Exclude<LeaveDayPortion, "full_day">>("first_half");
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [handover, setHandover] = useState("");
  const [lopAck, setLopAck] = useState(false);

  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);

  const previewMutation = useLeavePreview();
  const submitMutation = useSubmitLeave();

  const eligibleRules = useMemo(
    () => (rules.data ?? []).filter((rule) => isEligibleLeaveType(rule, context.data ?? null)),
    [rules.data, context.data],
  );
  const rule: LeaveTypeRule | undefined = eligibleRules.find((r) => r.id === leaveTypeId);
  const balance = useLeaveBalanceForType(rule?.id);

  // A type that cannot be taken as a half day forces the mode back to one day.
  useEffect(() => {
    if (mode === "half" && rule !== undefined && !rule.allow_half_day) setMode("one");
  }, [mode, rule]);

  const portion: LeaveDayPortion = mode === "half" ? half : "full_day";
  const effectiveTo = mode === "range" ? toDate : fromDate;
  const signature = signatureOf(leaveTypeId, fromDate, effectiveTo, portion);
  const isStale = preview !== null && previewSignature !== signature;
  const rangeInvalid = mode === "range" && effectiveTo < fromDate;

  const probationLocked = rule !== undefined && isProbationLocked(rule, context.data ?? null);
  const contactInvalid = contact.trim().length > 0 && !MOBILE_RE.test(contact.trim());
  const reasonTooShort = reason.trim().length < 10;
  const allocatesNothing = preview !== null && preview.totalDays <= 0;

  const blockers: string[] = [];
  if (probationLocked) blockers.push(t("leave.apply.blocked.probation"));
  if (preview === null) blockers.push(t("leave.apply.blocked.preview"));
  else if (isStale) blockers.push(t("leave.apply.blocked.stale"));
  else if (allocatesNothing) blockers.push(t("leave.apply.blocked.zero"));
  if (reasonTooShort) blockers.push(t("leave.apply.blocked.reason"));
  if (contactInvalid) blockers.push(t("leave.apply.blocked.contact"));

  const canPreview =
    leaveTypeId.length > 0 && fromDate.length === 10 && !rangeInvalid && !probationLocked;
  const canSubmit = blockers.length === 0 && preview !== null;

  function runPreview() {
    if (!canPreview) return;
    previewMutation.mutate(
      { leaveTypeId, fromDate, toDate: effectiveTo, portion, reason },
      {
        onSuccess: (result) => {
          setPreview(result);
          setPreviewSignature(signatureOf(leaveTypeId, fromDate, effectiveTo, portion));
        },
        onError: () => {
          setPreview(null);
          setPreviewSignature(null);
        },
      },
    );
  }

  function onSubmit() {
    if (!canSubmit || preview === null) return;
    submitMutation.mutate(
      {
        requestId: preview.requestId,
        reason,
        contactDuringLeave: contact.trim().length > 0 ? contact.trim() : null,
        handoverToEmployeeId: null,
        handoverNotes: handover.trim().length > 0 ? handover.trim() : null,
        unpaidDays: lopAck ? preview.totalDays : null,
      },
      {
        onSuccess: (request) => {
          toast.success(t("leave.apply.done", { ref: request.request_number }));
          navigate(`/me/leave/${request.id}`);
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        icon={CalendarPlus}
        title={t("leave.apply.title")}
        subtitle={t("leave.apply.subtitle")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link to="/me/leave">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("leave.apply.back")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={rules.isLoading || context.isLoading}
        error={rules.error ?? context.error}
        onRetry={() => {
          void rules.refetch();
          void context.refetch();
        }}
        isEmpty={eligibleRules.length === 0 && !rules.isLoading}
        empty={
          <EmptyState
            title={t("leave.balances.empty.title")}
            hint={t("leave.balances.empty.hint")}
          />
        }
        skeletonRows={4}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* ── Left column: what and when ─────────────────────────────────── */}
          <div className="space-y-6">
            <section aria-labelledby="apply-type">
              <SectionHeading step={1}>{t("leave.apply.step.type")}</SectionHeading>
              <div className="rounded-lg border bg-card p-4">
                <Label htmlFor="leave-type">{t("leave.apply.type.label")}</Label>
                <select
                  id="leave-type"
                  value={leaveTypeId}
                  onChange={(e) => {
                    setLeaveTypeId(e.target.value);
                    setPreview(null);
                    setPreviewSignature(null);
                  }}
                  className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">{t("leave.apply.type.placeholder")}</option>
                  {eligibleRules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>

                {rule !== undefined ? (
                  <>
                    <p className="mt-3 text-sm">
                      {!rule.is_paid ? (
                        <span className="text-muted-foreground">{t("leave.apply.type.unpaid")}</span>
                      ) : balance.isLoading ? (
                        <span className="text-muted-foreground">{t("app.loading")}</span>
                      ) : balance.data == null ? (
                        // No `leave_balances` row for this type — an unlimited or
                        // per-event type. Stating that beats a phantom "0 days".
                        <span className="text-muted-foreground">{t("leave.apply.type.unpaid")}</span>
                      ) : (
                        <span className="num font-medium">
                          {t("leave.apply.type.balance", {
                            days: fmtDays(balance.data.available_after_pending),
                          })}
                        </span>
                      )}
                    </p>

                    <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t("leave.apply.rules.title")}
                    </p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {[
                        rule.min_notice_days > 0
                          ? t("leave.apply.rules.notice", { days: rule.min_notice_days })
                          : t("leave.apply.rules.noNotice"),
                        rule.max_consecutive_days !== null
                          ? t("leave.apply.rules.maxConsecutive", {
                              days: fmtDays(rule.max_consecutive_days),
                            })
                          : null,
                        rule.max_backdated_days > 0
                          ? t("leave.apply.rules.backdated", { days: rule.max_backdated_days })
                          : t("leave.apply.rules.noBackdated"),
                        rule.requires_document_after_days !== null
                          ? t("leave.apply.rules.document", {
                              days: fmtDays(rule.requires_document_after_days),
                            })
                          : null,
                        rule.allow_half_day
                          ? t("leave.apply.rules.halfDay")
                          : t("leave.apply.rules.noHalfDay"),
                        rule.count_weekly_off_as_leave || rule.count_holiday_as_leave
                          ? t("leave.apply.rules.countsOff")
                          : t("leave.apply.rules.skipsOff"),
                      ]
                        .filter((v): v is string => v !== null)
                        .map((label) => (
                          <li key={label}>
                            <Badge variant="neutral">{label}</Badge>
                          </li>
                        ))}
                    </ul>

                    {probationLocked ? (
                      <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                        <span>
                          {t("leave.balance.probationHint", {
                            on:
                              context.data?.confirmation_due_date == null
                                ? ""
                                : t("leave.balance.probationOn", {
                                    date: fmtCivilDate(context.data.confirmation_due_date),
                                  }),
                          })}
                        </span>
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="apply-when">
              <SectionHeading step={2}>{t("leave.apply.step.when")}</SectionHeading>
              <div className="rounded-lg border bg-card p-4">
                <div role="group" aria-label={t("leave.apply.step.when")} className="flex flex-wrap gap-2">
                  {(
                    [
                      ["one", t("leave.apply.mode.oneDay")],
                      ["range", t("leave.apply.mode.range")],
                      ["half", t("leave.apply.mode.halfDay")],
                    ] as [WhenMode, string][]
                  ).map(([value, label]) => {
                    const disabled = value === "half" && rule !== undefined && !rule.allow_half_day;
                    return (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        variant={mode === value ? "default" : "outline"}
                        disabled={disabled}
                        aria-pressed={mode === value}
                        onClick={() => {
                          setMode(value);
                          setPreview(null);
                          setPreviewSignature(null);
                        }}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>

                {rule !== undefined && !rule.allow_half_day ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("leave.apply.half.unavailable", { name: rule.name })}
                  </p>
                ) : null}

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="leave-from">
                      {mode === "range" ? t("leave.apply.from") : t("leave.apply.date")}
                    </Label>
                    <Input
                      id="leave-from"
                      type="date"
                      className="mt-1.5 h-11"
                      value={fromDate}
                      onChange={(e) => {
                        setFromDate(e.target.value);
                        setPreview(null);
                        setPreviewSignature(null);
                      }}
                    />
                  </div>
                  {mode === "range" ? (
                    <div>
                      <Label htmlFor="leave-to">{t("leave.apply.to")}</Label>
                      <Input
                        id="leave-to"
                        type="date"
                        className="mt-1.5 h-11"
                        value={toDate}
                        onChange={(e) => {
                          setToDate(e.target.value);
                          setPreview(null);
                          setPreviewSignature(null);
                        }}
                      />
                    </div>
                  ) : null}
                  {mode === "half" ? (
                    <div>
                      <Label htmlFor="leave-half">{t("leave.apply.half.label")}</Label>
                      <select
                        id="leave-half"
                        value={half}
                        onChange={(e) => {
                          setHalf(e.target.value === "second_half" ? "second_half" : "first_half");
                          setPreview(null);
                          setPreviewSignature(null);
                        }}
                        className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="first_half">{t("leave.apply.half.first")}</option>
                        <option value="second_half">{t("leave.apply.half.second")}</option>
                      </select>
                    </div>
                  ) : null}
                </div>

                {rangeInvalid ? (
                  <p className="mt-2 text-sm text-destructive">{t("leave.apply.rangeInvalid")}</p>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={runPreview}
                    disabled={!canPreview || previewMutation.isPending}
                  >
                    {previewMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="h-4 w-4" aria-hidden />
                    )}
                    {preview === null ? t("leave.apply.preview.cta") : t("leave.apply.preview.recheck")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("leave.apply.draftNote")}</p>
                </div>
              </div>
            </section>
          </div>

          {/* ── Right column: the server's allocation, then the details ─────── */}
          <div className="space-y-6">
            <section aria-labelledby="apply-preview">
              <SectionHeading step={3}>{t("leave.apply.step.preview")}</SectionHeading>

              {previewMutation.isError ? (
                <div className="mb-3">
                  <ErrorState error={previewMutation.error} retry={runPreview} />
                </div>
              ) : null}

              {previewMutation.isPending ? (
                <div className="space-y-2" role="status" aria-live="polite">
                  <p className="text-sm text-muted-foreground">{t("leave.apply.preview.loading")}</p>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : preview === null ? (
                <EmptyState
                  title={t("leave.apply.preview.idle.title")}
                  hint={t("leave.apply.preview.idle.hint")}
                />
              ) : (
                <div className="space-y-3">
                  {isStale ? (
                    <p
                      className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
                      role="status"
                    >
                      {t("leave.apply.preview.stale")}
                    </p>
                  ) : null}

                  <div className="rounded-lg border bg-card p-4">
                    <p className="num font-display text-2xl font-semibold leading-none">
                      {t("leave.apply.preview.total", { days: fmtDays(preview.totalDays) })}
                    </p>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      {t("leave.apply.preview.split", {
                        paid: fmtDays(preview.paidDays),
                        unpaid: fmtDays(preview.unpaidDays),
                      })}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("leave.apply.preview.asAt", { when: fmtDateTime(preview.readAt) })}
                    </p>
                    {allocatesNothing ? (
                      <p className="mt-2 text-sm text-warning">{t("leave.apply.preview.zero")}</p>
                    ) : null}
                  </div>

                  <h3 className="text-sm font-medium">{t("leave.apply.preview.title")}</h3>
                  <AllocationTable
                    days={preview.days}
                    emptyTitle={t("leave.detail.allocation.empty.title")}
                    emptyHint={t("leave.detail.allocation.empty.hint")}
                  />
                </div>
              )}
            </section>

            <section aria-labelledby="apply-details">
              <SectionHeading step={4}>{t("leave.apply.step.details")}</SectionHeading>
              <div className="space-y-4 rounded-lg border bg-card p-4">
                <div>
                  <Label htmlFor="leave-reason">{t("leave.apply.reason")}</Label>
                  <textarea
                    id="leave-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder={t("leave.apply.reason.placeholder")}
                    aria-describedby="leave-reason-hint"
                    className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <p id="leave-reason-hint" className="mt-1 text-xs text-muted-foreground">
                    {t("leave.apply.reason.hint")}
                  </p>
                </div>

                <div>
                  <Label htmlFor="leave-contact">{t("leave.apply.contact")}</Label>
                  <Input
                    id="leave-contact"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    className={cn("mt-1.5 h-11", contactInvalid && "border-destructive")}
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    aria-invalid={contactInvalid}
                    aria-describedby="leave-contact-hint"
                  />
                  <p
                    id="leave-contact-hint"
                    className={cn("mt-1 text-xs", contactInvalid ? "text-destructive" : "text-muted-foreground")}
                  >
                    {contactInvalid ? t("leave.apply.contact.invalid") : t("leave.apply.contact.hint")}
                  </p>
                </div>

                <div>
                  <Label htmlFor="leave-handover">{t("leave.apply.handover")}</Label>
                  <textarea
                    id="leave-handover"
                    value={handover}
                    onChange={(e) => setHandover(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder={t("leave.apply.handover.placeholder")}
                    className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>

                {rule?.is_paid === true ? (
                  <div>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={lopAck}
                        onChange={(e) => setLopAck(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-input"
                      />
                      <span>{t("leave.apply.lop")}</span>
                    </label>
                    <p className="ml-6 mt-1 text-xs text-muted-foreground">
                      {t("leave.apply.lop.hint")}
                    </p>
                  </div>
                ) : null}

                {submitMutation.isError ? (
                  <div
                    className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
                    role="alert"
                  >
                    <p className="font-medium">{t("leave.apply.refused.title")}</p>
                    <p className="mt-1 break-words text-muted-foreground">
                      {submitMutation.error.message}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("leave.apply.refused.hint")}
                    </p>
                  </div>
                ) : null}

                {blockers.length > 0 ? (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <p className="font-medium">{t("leave.apply.blocked.title")}</p>
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
                  disabled={!canSubmit || submitMutation.isPending}
                  onClick={onSubmit}
                >
                  {submitMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      {t("leave.apply.submitting")}
                    </>
                  ) : (
                    t("leave.apply.submit")
                  )}
                </Button>
              </div>
            </section>
          </div>
        </div>
      </StateBoundary>
    </div>
  );
}
