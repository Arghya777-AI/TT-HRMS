/**
 * /admin/leave/apply — an administrator applying for leave FOR an employee.
 *
 * WHY IT EXISTS. Somebody phones in sick, or hands over a paper form at the desk, or has no
 * portal login yet. The employee's own screen is the only place a leave request could be
 * created, so HR's options were to ask the person to do it themselves — impossible if they
 * are ill or have no account — or to leave the day unrecorded and fix the attendance
 * afterwards, which puts the correction in the attendance trail rather than the leave one.
 *
 * IT REUSES THE EMPLOYEE'S OWN WRITE PATH, deliberately and entirely.
 * `leave_requests__admin_all` has always permitted an admin to insert and submit for anybody
 * in scope, and `previewLeaveRequest` / `submitLeaveRequest` were already parameterised by
 * employee and request rather than assuming the caller. So this screen chooses the employee
 * and calls the same two functions. A second implementation would be a second copy of a flow
 * guarded by five triggers, and the copy is how an admin-created request starts behaving
 * differently from a self-created one.
 *
 * THE PREVIEW IS THE CALCULATION, not a formatting step. Submitting writes a draft; the
 * server stamps `total_days`, `paid_days` and the expanded per-day rows from it. Nothing here
 * counts days: a range spanning a weekly off or a holiday is the server's arithmetic, and a
 * browser copy of it would disagree with the guard that refuses the submit.
 *
 * WHAT THE SERVER WILL REFUSE, learned by submitting a real request for employee 005 as an
 * admin against the live project, and why each field below exists:
 *
 *   * a range expanding to 0 counted days → "leave type EL requires at least 0.50"
 *   * `handover_to_employee_id` is MANDATORY for operational departments — hence the
 *     handover picker, without which a well-formed request is refused for a reason the
 *     admin cannot see
 *   * insufficient paid balance unless the overflow is marked unpaid — hence the LWP field
 *   * a reason of at least 10 characters (`ck_lr__reason`)
 *
 * THE REQUEST LANDS `pending`. An admin applying on somebody's behalf is still making a
 * request; it goes to the approver like any other. Creating it approved would move a leave
 * balance with nobody's name against the decision.
 *
 * @route /admin/leave/apply
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { mutationUserMessage } from "@/shared/api/query";
import { fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useEmployeeLeaveContext, usePreviewLeaveFor } from "../hooks/useLeaveOnBehalf";
import { useSubmitLeave } from "@/features/leave/hooks/useLeaveApply";
import { useLeaveTypeRules } from "@/features/leave/hooks/useLeaveApply";
import {
  isEligibleLeaveType,
  isProbationLocked,
  type LeavePreview,
} from "@/features/leave/api/leave-apply.api";

/** `leave_day_portion`. A half-day applies to a single date. */
const PORTIONS: readonly SelectOption[] = [
  { value: "full_day", label: t("admin.leaveFor.portion.full") },
  { value: "first_half", label: t("admin.leaveFor.portion.first") },
  { value: "second_half", label: t("admin.leaveFor.portion.second") },
];

export default function LeaveOnBehalfPage() {
  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const rules = useLeaveTypeRules();

  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [fromDate, setFromDate] = useState(nowIstDate());
  const [toDate, setToDate] = useState(nowIstDate());
  const [portion, setPortion] = useState("full_day");
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [handoverId, setHandoverId] = useState("");
  const [handoverNotes, setHandoverNotes] = useState("");
  const [unpaidDays, setUnpaidDays] = useState("");
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: string; days: number } | null>(null);

  const context = useEmployeeLeaveContext(employeeId === "" ? null : employeeId);
  const previewMutation = usePreviewLeaveFor();
  const submitMutation = useSubmitLeave();

  /**
   * Only the types this employee may actually use.
   *
   * `isEligibleLeaveType` mirrors `leave_requests_submit_guard`'s structural gates —
   * employment type and gender restriction — and is imported rather than reimplemented so
   * the admin form cannot offer a type the employee's own form would hide. Probation is
   * shown rather than blocked, matching the employee screen.
   */
  const typeChoices: SelectOption[] = useMemo(() => {
    const ctx = context.data ?? null;
    return (rules.data ?? [])
      .filter((rule) => isEligibleLeaveType(rule, ctx))
      .map((rule) => ({
        value: rule.id,
        label: isProbationLocked(rule, ctx)
          ? t("admin.leaveFor.typeProbation", { name: rule.name })
          : rule.name,
      }));
  }, [rules.data, context.data]);

  /** Handover cannot be the applicant — the server would be recording a self-handover. */
  const handoverChoices = useMemo(
    () => employeeChoices.filter((option) => option.value !== employeeId),
    [employeeChoices, employeeId],
  );

  const canPreview =
    employeeId !== "" && leaveTypeId !== "" && fromDate !== "" && toDate !== "";
  const canSubmit = preview !== null && reason.trim().length >= 10;

  function runPreview(): void {
    setError(null);
    setDone(null);
    previewMutation.mutate(
      {
        employeeId,
        leaveTypeId,
        fromDate,
        toDate,
        portion: portion as "full_day" | "first_half" | "second_half",
        reason,
      },
      {
        onSuccess: (result) => setPreview(result),
        onError: (err: unknown) => {
          setPreview(null);
          setError(mutationUserMessage(err));
        },
      },
    );
  }

  function runSubmit(): void {
    if (preview === null) return;
    setError(null);
    submitMutation.mutate(
      {
        requestId: preview.requestId,
        reason: reason.trim(),
        contactDuringLeave: contact.trim() === "" ? null : contact.trim(),
        handoverToEmployeeId: handoverId === "" ? null : handoverId,
        handoverNotes: handoverNotes.trim() === "" ? null : handoverNotes.trim(),
        unpaidDays: unpaidDays.trim() === "" ? null : Number.parseFloat(unpaidDays),
      },
      {
        onSuccess: (request) => {
          setDone({ number: request.request_number, days: preview.totalDays });
          setPreview(null);
          setReason("");
        },
        onError: (err: unknown) => setError(mutationUserMessage(err)),
      },
    );
  }

  const busy = previewMutation.isPending || submitMutation.isPending;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarPlus}
        title={t("admin.leaveFor.title")}
        subtitle={t("admin.leaveFor.subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/leave/requests">{t("admin.leaveFor.allRequests")}</Link>
          </Button>
        }
      />

      <Notice tone="info" className="mb-5">
        <p className="font-medium">{t("admin.leaveFor.rules.title")}</p>
        <p className="mt-1">{t("admin.leaveFor.rules.body")}</p>
      </Notice>

      {done !== null ? (
        <Notice tone="success" className="mb-5">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("admin.leaveFor.done", {
              number: done.number,
              days: formatNumber(done.days),
            })}
          </p>
          <p className="mt-1 text-xs">{t("admin.leaveFor.doneHint")}</p>
        </Notice>
      ) : null}

      {error !== null ? (
        <Notice tone="error" className="mb-5">
          {error}
        </Notice>
      ) : null}

      <StateBoundary
        loading={labels.isPending || rules.isPending}
        error={labels.error ?? rules.error}
        onRetry={() => void labels.refetch()}
        skeletonRows={4}
      >
        <section className="rounded-lg border bg-card p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("admin.leaveFor.employee")}
              value={employeeId}
              options={employeeChoices}
              onChange={(value) => {
                setEmployeeId(value);
                setPreview(null);
                setLeaveTypeId("");
                setHandoverId("");
              }}
              placeholder="—"
              required
              disabled={busy}
              hint={t("admin.leaveFor.employeeHint")}
            />
            <SelectField
              label={t("admin.leaveFor.type")}
              value={leaveTypeId}
              options={typeChoices}
              onChange={(value) => {
                setLeaveTypeId(value);
                setPreview(null);
              }}
              placeholder="—"
              required
              disabled={busy || employeeId === ""}
              hint={
                employeeId === ""
                  ? t("admin.leaveFor.typeNeedsEmployee")
                  : t("admin.leaveFor.typeHint")
              }
            />
            <TextField
              label={t("admin.leaveFor.from")}
              value={fromDate}
              onChange={(value) => {
                setFromDate(value);
                setPreview(null);
              }}
              type="date"
              required
              disabled={busy}
            />
            <TextField
              label={t("admin.leaveFor.to")}
              value={toDate}
              onChange={(value) => {
                setToDate(value);
                setPreview(null);
              }}
              type="date"
              required
              disabled={busy}
            />
            <SelectField
              label={t("admin.leaveFor.portion")}
              value={portion}
              options={PORTIONS}
              onChange={(value) => {
                setPortion(value);
                setPreview(null);
              }}
              disabled={busy}
              hint={t("admin.leaveFor.portionHint")}
            />
            <TextField
              label={t("admin.leaveFor.contact")}
              value={contact}
              onChange={setContact}
              disabled={busy}
              hint={t("admin.leaveFor.contactHint")}
            />
            {/* Mandatory for operational departments — the server refuses without it. */}
            <SelectField
              label={t("admin.leaveFor.handover")}
              value={handoverId}
              options={handoverChoices}
              onChange={setHandoverId}
              placeholder="—"
              disabled={busy || employeeId === ""}
              hint={t("admin.leaveFor.handoverHint")}
            />
            <TextField
              label={t("admin.leaveFor.handoverNotes")}
              value={handoverNotes}
              onChange={setHandoverNotes}
              disabled={busy || handoverId === ""}
              hint={t("admin.leaveFor.handoverNotesHint")}
            />
            <TextField
              label={t("admin.leaveFor.unpaid")}
              value={unpaidDays}
              onChange={setUnpaidDays}
              type="number"
              min="0"
              disabled={busy}
              hint={t("admin.leaveFor.unpaidHint")}
            />
          </div>

          <div className="mt-4">
            <TextField
              label={t("admin.leaveFor.reason")}
              value={reason}
              onChange={setReason}
              disabled={busy}
              hint={t("admin.leaveFor.reasonHint")}
              placeholder={t("admin.leaveFor.reasonPlaceholder")}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={!canPreview || busy}
              onClick={runPreview}
            >
              {previewMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : null}
              {t("admin.leaveFor.check")}
            </Button>
            <Button type="button" disabled={!canSubmit || busy} onClick={runSubmit}>
              {submitMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : null}
              {t("admin.leaveFor.submit")}
            </Button>
            {preview === null ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.leaveFor.checkFirst")}
              </span>
            ) : null}
          </div>
        </section>

        {/* The server's arithmetic, read back. Nothing on this page counts days. */}
        {preview !== null ? (
          <section className="mt-4 rounded-lg border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">
              {t("admin.leaveFor.preview.title", { number: preview.requestNumber })}
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <dt className="text-muted-foreground">{t("admin.leaveFor.preview.total")}</dt>
              <dd className="num font-medium">{formatNumber(preview.totalDays)}</dd>
              <dt className="text-muted-foreground">{t("admin.leaveFor.preview.paid")}</dt>
              <dd className="num font-medium">{formatNumber(preview.paidDays)}</dd>
              <dt className="text-muted-foreground">{t("admin.leaveFor.preview.unpaid")}</dt>
              <dd className="num font-medium">{formatNumber(preview.unpaidDays)}</dd>
              <dt className="text-muted-foreground">{t("admin.leaveFor.preview.days")}</dt>
              <dd className="num font-medium">{formatNumber(preview.days.length)}</dd>
            </dl>
            {preview.days.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {preview.days.map((day) => (
                  <li
                    key={day.leave_date}
                    className="rounded-full border bg-background/60 px-2 py-0.5 text-xs"
                  >
                    {fmtCivilDate(day.leave_date)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-warning">{t("admin.leaveFor.preview.noDays")}</p>
            )}
          </section>
        ) : null}
      </StateBoundary>
    </div>
  );
}
