/**
 * E-04.3 · /me/regularizations/new — ask for a punch correction.
 *
 * Order on the page is deliberate and specified (spec-employee §5 E-04):
 *   1. the date,
 *   2. the CURRENT server record for that date — shown BEFORE the type choice,
 *      so the employee corrects the record rather than their memory,
 *   3. the correction type,
 *   4. the times / status being asked for,
 *   5. a LIVE SERVER preview of the effect,
 *   6. reason (15–500) and evidence (mandatory for `marked_absent`),
 *   7. the monthly quota state.
 *
 * The current-record panel reads the SAME row as `/me/attendance` (the
 * `v_attendance_day_enriched` row via `useAttendanceDay`), so the two screens
 * cannot disagree. Nothing here recomputes worked minutes, lateness or a day
 * status: when the server dry-run is unavailable the preview says so and shows
 * only what the employee typed.
 *
 * @route /me/regularizations/new
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ClipboardList, Info, Lock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDurationHm, fmtMonth, fmtTime, nowIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAttendanceDay, useAttendancePunches } from "../hooks/useAttendance";
import {
  EVIDENCE_MANDATORY_KINDS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  STATUS_KINDS,
  TIME_KINDS,
  civilDateMinusDays,
  istWallClockToInstant,
  regularizationKindValues,
  uploadRegularizationEvidence,
  type RegularizationKind,
} from "../api/regularizations.api";
import {
  useRegularizationPolicy,
  useRegularizationPreview,
  useRegularizationQuota,
  useSubmitRegularization,
} from "../hooks/useRegularizations";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { kindLabel } from "./MyRegularizations.page";

const REASON_MIN = 15;
const REASON_MAX = 500;

function SectionCard({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          <span
            className="grid h-6 w-6 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
            aria-hidden
          >
            {step}
          </span>
          {title}
        </h2>
        {hint ? <p className="mt-1.5 pl-8 text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="pl-0 sm:pl-8">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="num mt-0.5 truncate text-sm">{value}</dd>
    </div>
  );
}

export default function NewRegularizationPage() {
  const navigate = useNavigate();
  const employeeId = useEmployeeId();
  const [params] = useSearchParams();
  const today = nowIstDate();

  const paramDate = params.get("date");
  const paramType = params.get("type");
  const [date, setDate] = useState(
    paramDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(paramDate) ? paramDate : today,
  );
  const [kind, setKind] = useState<RegularizationKind | null>(
    paramType !== null && (regularizationKindValues as readonly string[]).includes(paramType)
      ? (paramType as RegularizationKind)
      : null,
  );
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const day = useAttendanceDay(date);
  const punches = useAttendancePunches(date);
  const policy = useRegularizationPolicy(date);
  const quota = useRegularizationQuota(date);
  const submit = useSubmitRegularization();

  const windowDays = policy.data?.regularization_window_days ?? null;
  const windowFrom = windowDays === null ? null : civilDateMinusDays(today, windowDays);
  const isLocked = day.data?.is_locked === true;

  const needsTimes = kind !== null && TIME_KINDS.includes(kind);
  const needsStatus = kind !== null && STATUS_KINDS.includes(kind);
  const needsEvidence = kind !== null && EVIDENCE_MANDATORY_KINDS.includes(kind);

  /*
    ── A STATUS DAY STILL HAS HOURS IN IT ─────────────────────────────────────
    `on_duty` and `work_from_home` are STATUS_KINDS, and this form used to hide the time
    fields for them completely — the section rendered nothing but the kind's own name. So
    "I was on duty" could be said and "from 08:30" could not.

    A sales manager took a client call from home at 08:30, could not punch for it, and filed
    `on_duty`. It was approved and it worked: the day is on_duty and paid in full. But it
    carries NO times, so her attendance screen showed her arriving at 12:40 — the gate scan
    from when she reached the venue — and the day reads zero worked minutes. Paid correctly
    and recorded as having done nothing. Her report was "I don't see any changes in my login
    timings", and she was right.

    The database always allowed both: `requested_status` and the two time columns are
    independent, and `apply_approved_regularization` creates the punches when times are
    present and sets the status either way. Only this screen forbade the combination.

    So times are now OFFERED on a status kind and REQUIRED on a time kind. Somebody claiming
    a whole day on duty with no particular hours can still say just that.
  */
  const allowsTimes = needsTimes || needsStatus;

  const requestedFirstInAt = useMemo(
    () => (allowsTimes && inTime.length === 5 ? istWallClockToInstant(date, inTime) : null),
    [allowsTimes, inTime, date],
  );
  const requestedLastOutAt = useMemo(
    () => (allowsTimes && outTime.length === 5 ? istWallClockToInstant(date, outTime) : null),
    [allowsTimes, outTime, date],
  );
  const requestedStatus = needsStatus ? kind : null;

  const timesOrderOk =
    requestedFirstInAt === null ||
    requestedLastOutAt === null ||
    new Date(requestedLastOutAt).getTime() > new Date(requestedFirstInAt).getTime();

  /*
    A time kind is not submittable without at least one time — that IS the request. A status
    kind is, because the status is the request; but if times were typed they still have to
    make sense, so the ordering check applies to both.
  */
  const timesComplete = needsTimes
    ? (requestedFirstInAt !== null || requestedLastOutAt !== null) && timesOrderOk
    : needsStatus && timesOrderOk;

  const cap = quota.data?.cap ?? null;
  const used = quota.data?.used ?? 0;
  const monthLabel = fmtMonth(`${date.slice(0, 7)}-01T00:00:00+05:30`);
  const quotaBlocked = cap !== null && used >= cap;
  const quotaAmber = cap !== null && !quotaBlocked && used >= cap - 1;

  const reasonLen = reason.trim().length;
  const reasonOk = reasonLen >= REASON_MIN && reasonLen <= REASON_MAX;
  const dateOk =
    date <= today && (windowFrom === null || date >= windowFrom) && !isLocked;
  const evidenceOk = !needsEvidence || evidence !== null;

  const canSubmit =
    employeeId !== null &&
    kind !== null &&
    dateOk &&
    timesComplete &&
    reasonOk &&
    evidenceOk &&
    !quotaBlocked &&
    !submitting;

  // ── Live server preview, debounced so a keystroke is not a request ────────
  const [previewInput, setPreviewInput] = useState<{
    employeeId: string;
    istDate: string;
    kind: RegularizationKind;
    requestedFirstInAt: string | null;
    requestedLastOutAt: string | null;
    requestedStatus: string | null;
  } | null>(null);

  useEffect(() => {
    if (employeeId === null || kind === null || !dateOk || !timesComplete) {
      setPreviewInput(null);
      return;
    }
    const handle = window.setTimeout(() => {
      setPreviewInput({
        employeeId,
        istDate: date,
        kind,
        requestedFirstInAt,
        requestedLastOutAt,
        requestedStatus,
      });
    }, 450);
    return () => window.clearTimeout(handle);
  }, [
    employeeId,
    kind,
    dateOk,
    timesComplete,
    date,
    requestedFirstInAt,
    requestedLastOutAt,
    requestedStatus,
  ]);

  const preview = useRegularizationPreview(previewInput);

  function onPickEvidence(file: File | null) {
    setEvidenceError(null);
    if (file === null) {
      setEvidence(null);
      return;
    }
    if (file.size > EVIDENCE_MAX_BYTES) {
      setEvidenceError(t("reg.form.evidenceHint"));
      setEvidence(null);
      return;
    }
    if (!(EVIDENCE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setEvidenceError(t("reg.form.evidenceHint"));
      setEvidence(null);
      return;
    }
    setEvidence(file);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || employeeId === null || kind === null) return;
    setSubmitting(true);
    try {
      if (evidence !== null) {
        // Stored in the caller's own private folder; see the note in the api
        // module about why it cannot yet be linked as supporting_document_id.
        await uploadRegularizationEvidence(employeeId, evidence);
      }
      await submit.mutateAsync({
        employeeId,
        istDate: date,
        kind,
        requestedFirstInAt,
        requestedLastOutAt,
        requestedStatus,
        reason: reason.trim(),
        supportingDocumentId: null,
      });
      toast.success(t("reg.form.submitted"));
      navigate("/me/regularizations");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("error.hint");
      toast.error(message.includes("23505") || message.includes("duplicate") ? t("reg.form.duplicate") : message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container max-w-3xl py-6">
      <PageHeader
        icon={ClipboardList}
        title={t("reg.form.title")}
        subtitle={t("reg.form.subtitle")}
        actions={
          <Button variant="ghost" asChild>
            <Link to="/me/regularizations">{t("reg.list.title")}</Link>
          </Button>
        }
      />

      <form onSubmit={onSubmit} className="space-y-4">
        {/* 1 ── the date */}
        <SectionCard
          step={1}
          title={t("reg.form.date")}
          {...(windowDays !== null ? { hint: t("reg.form.dateHint", { days: windowDays }) } : {})}
        >
          <Input
            type="date"
            value={date}
            max={today}
            {...(windowFrom !== null ? { min: windowFrom } : {})}
            onChange={(e) => setDate(e.target.value)}
            className="max-w-xs"
            aria-label={t("reg.form.date")}
          />
          {isLocked ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              {t("reg.form.current.locked")}
            </p>
          ) : null}
        </SectionCard>

        {/* 2 ── the CURRENT record, before any type choice */}
        <SectionCard step={2} title={t("reg.form.current.title")} hint={t("reg.form.current.hint")}>
          <StateBoundary
            loading={day.isLoading}
            error={day.error ?? undefined}
            onRetry={() => void day.refetch()}
            skeletonRows={2}
          >
            {day.data === null || day.data === undefined ? (
              <p className="text-sm text-muted-foreground">{t("reg.form.current.none")}</p>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field
                    label={t("reg.form.current.status")}
                    value={<StatusChip status={day.data.status} />}
                  />
                  <Field
                    label={t("reg.form.current.shift")}
                    value={dash(day.data.shift_display_label)}
                  />
                  <Field
                    label={t("reg.form.current.in")}
                    value={dash(day.data.first_in_at, fmtTime)}
                  />
                  <Field
                    label={t("reg.form.current.out")}
                    value={dash(day.data.last_out_at, fmtTime)}
                  />
                  <Field
                    label={t("reg.form.current.worked")}
                    value={fmtDurationHm(day.data.total_worked_minutes)}
                  />
                  <Field
                    label={t("reg.form.current.late")}
                    value={fmtDurationHm(day.data.late_minutes)}
                  />
                </dl>
                <div className="mt-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("reg.form.current.scans")}
                  </p>
                  {punches.isLoading ? (
                    <Skeleton className="mt-2 h-5 w-40" />
                  ) : (punches.data ?? []).length === 0 ? (
                    <p className="num mt-1 text-sm">{dash(null)}</p>
                  ) : (
                    <ul className="mt-1.5 flex flex-wrap gap-2">
                      {(punches.data ?? []).map((p) => (
                        <li
                          key={p.id}
                          className="num rounded-md border px-2 py-1 text-xs"
                          title={dash(p.source_label)}
                        >
                          {dash(p.punched_at, fmtTime)} · {p.derived_direction}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </StateBoundary>
        </SectionCard>

        {/* 3 ── the correction type */}
        <SectionCard step={3} title={t("reg.form.type")} hint={t("reg.form.type.hint")}>
          <fieldset>
            <legend className="sr-only">{t("reg.form.type")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {regularizationKindValues.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50",
                    kind === value && "border-primary bg-primary/5",
                  )}
                >
                  <input
                    type="radio"
                    name="regularization-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                  {kindLabel(value)}
                </label>
              ))}
            </div>
          </fieldset>
        </SectionCard>

        {/* 4 ── times / status asked for */}
        {kind !== null ? (
          <SectionCard step={4} title={t("reg.form.times")}>
            {allowsTimes ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {/* On a status kind the day's status IS the claim; the hours are extra. */}
                {needsStatus ? (
                  <p className="text-sm text-muted-foreground sm:col-span-2">
                    {kindLabel(kind)} — {t("reg.form.times.optional")}
                  </p>
                ) : null}
                <div>
                  <Label htmlFor="reg-in">{t("reg.form.in")}</Label>
                  <Input
                    id="reg-in"
                    type="time"
                    value={inTime}
                    onChange={(e) => setInTime(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="reg-out">{t("reg.form.out")}</Label>
                  <Input
                    id="reg-out"
                    type="time"
                    value={outTime}
                    onChange={(e) => setOutTime(e.target.value)}
                    className="mt-1.5"
                  />
                </div>
                {!timesOrderOk ? (
                  <p className="text-sm text-destructive sm:col-span-2">
                    {t("reg.form.out")} &gt; {t("reg.form.in")}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{kindLabel(kind)}</p>
            )}
          </SectionCard>
        ) : null}

        {/* 5 ── live server preview */}
        {kind !== null ? (
          <SectionCard step={5} title={t("reg.form.preview.title")} hint={t("reg.form.preview.hint")}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">&nbsp;</th>
                    <th className="pb-2 font-medium">{t("reg.form.preview.now")}</th>
                    <th className="pb-2 font-medium">{t("reg.form.preview.requested")}</th>
                    <th className="pb-2 font-medium">{t("reg.form.preview.effect")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                      {t("reg.form.current.in")}
                    </th>
                    <td className="num py-2">{dash(day.data?.first_in_at ?? null, fmtTime)}</td>
                    <td className="num py-2">{dash(requestedFirstInAt, fmtTime)}</td>
                    <td className="num py-2">
                      {preview.data ? dash(preview.data.first_in_at, fmtTime) : dash(null)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                      {t("reg.form.current.out")}
                    </th>
                    <td className="num py-2">{dash(day.data?.last_out_at ?? null, fmtTime)}</td>
                    <td className="num py-2">{dash(requestedLastOutAt, fmtTime)}</td>
                    <td className="num py-2">
                      {preview.data ? dash(preview.data.last_out_at, fmtTime) : dash(null)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                      {t("reg.form.current.worked")}
                    </th>
                    <td className="num py-2">{fmtDurationHm(day.data?.total_worked_minutes ?? null)}</td>
                    <td className="num py-2">{dash(null)}</td>
                    <td className="num py-2">
                      {preview.data ? fmtDurationHm(preview.data.total_worked_minutes) : dash(null)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                      {t("reg.form.current.status")}
                    </th>
                    <td className="py-2">
                      {day.data ? <StatusChip status={day.data.status} /> : dash(null)}
                    </td>
                    <td className="py-2">
                      {requestedStatus !== null ? <StatusChip status={requestedStatus} /> : dash(null)}
                    </td>
                    <td className="py-2">
                      {preview.data ? <StatusChip status={preview.data.status} /> : dash(null)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {preview.isFetching ? (
              <Skeleton className="mt-3 h-4 w-48" />
            ) : preview.data === undefined ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t("reg.form.preview.unavailable")}
              </p>
            ) : null}
          </SectionCard>
        ) : null}

        {/* 6 ── reason + evidence */}
        <SectionCard step={6} title={t("reg.form.reason")} hint={t("reg.form.reasonHint")}>
          <textarea
            id="reg-reason"
            value={reason}
            maxLength={REASON_MAX}
            rows={4}
            onChange={(e) => setReason(e.target.value)}
            aria-label={t("reg.form.reason")}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={cn("text-muted-foreground", reasonLen > 0 && !reasonOk && "text-destructive")}>
              {reasonLen < REASON_MIN
                ? t("reg.form.reasonShort", { n: REASON_MIN - reasonLen })
                : t("reg.form.reasonCount", { n: reasonLen })}
            </span>
          </div>

          <div className="mt-5">
            <Label htmlFor="reg-evidence">
              {t("reg.form.evidence")}
              {needsEvidence ? <span className="ml-1 text-destructive">*</span> : null}
            </Label>
            <input
              id="reg-evidence"
              type="file"
              accept={EVIDENCE_MIME_TYPES.join(",")}
              onChange={(e) => onPickEvidence(e.target.files?.[0] ?? null)}
              className="mt-1.5 block w-full text-sm file:mr-3 file:h-9 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">{t("reg.form.evidenceHint")}</p>
            {needsEvidence && evidence === null ? (
              <p className="mt-1.5 text-xs text-destructive">{t("reg.form.evidenceRequired")}</p>
            ) : null}
            {evidenceError !== null ? (
              <p className="mt-1.5 text-xs text-destructive">{evidenceError}</p>
            ) : null}
          </div>
        </SectionCard>

        {/* 7 ── quota */}
        <SectionCard step={7} title={t("reg.quota.title")}>
          <p
            className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
              quotaBlocked && "border-destructive/40 bg-destructive/5",
              quotaAmber && "border-warning/40 bg-warning/5",
            )}
          >
            {quotaBlocked || quotaAmber ? (
              <TriangleAlert
                className={cn("mt-0.5 h-4 w-4 shrink-0", quotaBlocked ? "text-destructive" : "text-warning")}
                aria-hidden
              />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span>
              {cap === null
                ? t("reg.form.serverRules")
                : quotaBlocked
                  ? t("reg.quota.blocked", { cap, month: monthLabel })
                  : quotaAmber
                    ? t("reg.quota.amber", { month: monthLabel })
                    : t("reg.quota.used", { used, cap, month: monthLabel })}
            </span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t("reg.form.serverRules")}</p>
        </SectionCard>

        <div className="flex flex-wrap items-center justify-end gap-3 pb-4">
          <span className="mr-auto text-xs text-muted-foreground">
            {t("reg.col.date")}: {fmtCivilDate(date)}
          </span>
          <Button variant="outline" type="button" asChild>
            <Link to="/me/regularizations">{t("common.close")}</Link>
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? t("reg.form.submitting") : t("reg.form.submit")}
          </Button>
        </div>
      </form>
    </div>
  );
}
