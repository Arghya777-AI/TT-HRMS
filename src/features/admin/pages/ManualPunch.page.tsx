/**
 * §4 · /admin/attendance/punches/new — Manual Punch. Record a scan by employee
 * code when the camera at the gate fails.
 *
 * This form is DELIBERATELY SLOW. Every other screen in the admin console reads
 * the system of record; this one writes to it, on behalf of a person who is not
 * present, from a fact nobody photographed. So it carries friction on purpose:
 *
 *  1. THE CODE IS RESOLVED TO A NAME AND THE NAME IS CONFIRMED. A guard reading
 *     'TT-014' off a lanyard and an admin typing 'TT-041' is the failure mode,
 *     and it lands as somebody else's attendance. Nothing can be submitted until
 *     the admin has been shown the person the code belongs to and has ticked to
 *     say that is who they mean. Editing the code un-confirms it.
 *  2. THE CLOCK IS IST, TYPED, AND 24-HOUR. The time is a plain 'HH:mm' text
 *     field rather than `<input type="time">` on purpose: the native picker
 *     renders a 12-hour AM/PM control under an en-US locale, and a 12-hour clock
 *     is banned app-wide (DR-53). The typed IST wall clock is converted by
 *     `istWallClockToInstant` — the ONE sanctioned civil-date + wall-clock →
 *     instant conversion. A Date is never assembled from parts here, because
 *     deriving an instant in the browser's own zone is exactly how the reference
 *     product mis-filed every scan between 00:00 and 05:29 IST.
 *  3. THE REASON IS THE RECORD, NOT A CEREMONY. The sentence explaining why the
 *     camera was not used is stored on the punch AND on the audit row, and it is
 *     what an auditor reads in six months. It is required, with a floor of 15
 *     characters (D-21), and the screen says who it will be attributed to before
 *     a single character is typed.
 *  4. DIRECTION IS PROVENANCE, NOT A DECISION. The screen states that picking
 *     'in' does not make this scan the arrival: the FIRST scan of the IST day is
 *     arrival and the LAST is departure, decided by the attendance engine from
 *     the whole day's scans. Nothing on this page computes anything.
 *
 * WHY SUBMIT IS BLOCKED, and why that is the honest build: there is no server
 * path for this write. `attendance_punches` has no INSERT policy for any client
 * role and migration 016 REVOKEs INSERT from them, so a PostgREST insert is a
 * 42501 — not a thing to attempt. `supabase/functions/` contains exactly two
 * writers of the table: `void-punch`, which only voids, and `kiosk-punch`, which
 * is auth model D+O (device HMAC + open operator session), demands a 128-float
 * face descriptor under a `.strict()` schema, and hard-codes
 * `source = 'kiosk_face'`. An admin browser session satisfies none of that, and
 * `source = 'manual_admin'` — the value this punch must carry — is written by
 * nothing in the repo. So the form validates the complete payload, shows exactly
 * what it would send, and refuses to claim it was recorded. See
 * `MANUAL_PUNCH_WRITE_AVAILABLE` in `usePunchConsole.ts`.
 *
 * @route /admin/attendance/punches/new
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ScanFace, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/shared/ui/PageHeader";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import {
  fmtCivilDateWeekday,
  fmtDateTime,
  isFutureIstDate,
  istWallClockToInstant,
  nowIstDate,
} from "@/lib/datetime";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import {
  MANUAL_PUNCH_FN,
  MANUAL_PUNCH_WRITE_AVAILABLE,
  normaliseEmployeeCode,
  punchDirectionLabel,
  useDirectionOptions,
  useEmployeeCodeIndex,
  type ManualPunchDirection,
} from "../hooks/usePunchConsole";

/** 'HH:mm', 24-hour. The only shape `istWallClockToInstant` accepts. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The civil date + typed wall clock as a UTC instant, or null when the pair is
 * not yet a valid IST moment. Validation, not arithmetic: the conversion itself
 * is `datetime.ts`'s, and it is the only place a date and a time are combined.
 */
function toInstant(isoDate: string, hhmm: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  if (!HHMM.test(hhmm)) return null;
  try {
    return istWallClockToInstant(isoDate, hhmm);
  } catch {
    return null;
  }
}

export default function ManualPunchPage() {
  const { employee } = useAuth();
  const actorName = employee?.displayName ?? null;
  const actorCode = employee?.employeeCode ?? null;

  const today = nowIstDate();
  const directions = useDirectionOptions();
  const { index, isLoading: peopleLoading, error: peopleError } = useEmployeeCodeIndex();

  const [codeInput, setCodeInput] = useState("");
  const [confirmedCode, setConfirmedCode] = useState<string | null>(null);
  const [istDateInput, setIstDateInput] = useState(today);
  const [timeInput, setTimeInput] = useState("");
  const [direction, setDirection] = useState<ManualPunchDirection>("undetermined");
  const [reason, setReason] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const normalised = normaliseEmployeeCode(codeInput);
  const person = normalised === "" ? undefined : index.get(normalised);

  // Confirmation belongs to ONE code. Retyping the code withdraws it, rather
  // than leaving a tick from the previous person standing over a new one.
  const isConfirmed = confirmedCode !== null && confirmedCode === normalised && person !== undefined;

  const instant = toInstant(istDateInput, timeInput);
  const dateIsFuture = /^\d{4}-\d{2}-\d{2}$/.test(istDateInput) && isFutureIstDate(istDateInput);
  const trimmedReason = reason.trim();
  const reasonLongEnough = trimmedReason.length >= SENSITIVE_REASON_LENGTH;

  const errors = useMemo(() => {
    const codeError =
      normalised === ""
        ? t("admin.manualPunch.error.codeRequired")
        : person === undefined
          ? peopleLoading
            ? t("admin.manualPunch.error.stillLoading")
            : t("admin.manualPunch.error.codeUnknown", { code: normalised })
          : !isConfirmed
            ? t("admin.manualPunch.error.notConfirmed")
            : null;
    const dateError =
      !/^\d{4}-\d{2}-\d{2}$/.test(istDateInput)
        ? t("admin.manualPunch.error.dateRequired")
        : dateIsFuture
          ? t("admin.manualPunch.error.dateFuture")
          : null;
    const timeError =
      timeInput.trim() === ""
        ? t("admin.manualPunch.error.timeRequired")
        : !HHMM.test(timeInput.trim())
          ? t("admin.manualPunch.error.timeShape")
          : null;
    const reasonError = !reasonLongEnough ? t("admin.manualPunch.error.reasonShort") : null;
    return { codeError, dateError, timeError, reasonError };
  }, [
    normalised,
    person,
    peopleLoading,
    isConfirmed,
    istDateInput,
    dateIsFuture,
    timeInput,
    reasonLongEnough,
  ]);

  const isComplete =
    errors.codeError === null &&
    errors.dateError === null &&
    errors.timeError === null &&
    errors.reasonError === null &&
    instant !== null;

  const show = (message: string | null): string | null => (showErrors ? message : null);

  return (
    <div className="container max-w-3xl py-6">
      <PageHeader
        icon={ScanFace}
        title={t("admin.manualPunch.title")}
        subtitle={t("admin.manualPunch.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/attendance/punches">{t("admin.manualPunch.action.backToLog")}</Link>
          </Button>
        }
      />

      {/* Attribution, stated BEFORE the form rather than in fine print under it. */}
      <div className="mt-4 space-y-3">
        <Notice tone="warning">
          {actorName === null
            ? t("admin.manualPunch.attribution.unknown")
            : t("admin.manualPunch.attribution", {
                name: actorName,
                code: dash(actorCode),
              })}
        </Notice>

        {!MANUAL_PUNCH_WRITE_AVAILABLE ? (
          <Notice tone="error">
            {t("admin.manualPunch.noEndpoint", { fn: MANUAL_PUNCH_FN })}
          </Notice>
        ) : null}

        {peopleError !== null ? (
          <Notice tone="error">{t("admin.manualPunch.peopleFailed")}</Notice>
        ) : null}
      </div>

      {/* ── 1 · Who ───────────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="font-display text-sm font-semibold">
          {t("admin.manualPunch.step.who")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.manualPunch.step.whoHint")}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("admin.manualPunch.field.code")}
            value={codeInput}
            onChange={(value) => {
              setCodeInput(value);
              setConfirmedCode(null);
            }}
            placeholder={t("admin.manualPunch.field.codePlaceholder")}
            required
            disabled={peopleLoading}
            error={show(errors.codeError)}
            hint={t("admin.manualPunch.field.codeHint")}
          />

          <div className="min-w-0 space-y-1.5">
            <Label>{t("admin.manualPunch.field.resolved")}</Label>
            <div className="flex min-h-10 items-center rounded-md border border-input bg-background px-3 py-2 text-sm">
              {normalised === "" ? (
                <span className="text-muted-foreground">
                  {t("admin.manualPunch.resolved.waiting")}
                </span>
              ) : person === undefined ? (
                <span className="text-muted-foreground">
                  {peopleLoading
                    ? t("admin.manualPunch.resolved.loading")
                    : t("admin.manualPunch.resolved.noMatch")}
                </span>
              ) : (
                <PersonCell
                  name={person.name}
                  code={person.code}
                  secondary={person.department ?? person.designation}
                />
              )}
            </div>
          </div>
        </div>

        {person !== undefined ? (
          <label className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            <input
              type="checkbox"
              checked={isConfirmed}
              onChange={(event) => setConfirmedCode(event.target.checked ? normalised : null)}
              className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span>{t("admin.manualPunch.confirmByName", { name: person.name })}</span>
          </label>
        ) : null}
      </section>

      {/* ── 2 · When ──────────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-sm font-semibold">
          {t("admin.manualPunch.step.when")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.manualPunch.step.whenHint")}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <TextField
            label={t("admin.manualPunch.field.date")}
            type="date"
            value={istDateInput}
            onChange={setIstDateInput}
            max={today}
            required
            error={show(errors.dateError)}
          />
          <TextField
            label={t("admin.manualPunch.field.time")}
            value={timeInput}
            onChange={setTimeInput}
            placeholder={t("admin.manualPunch.field.timePlaceholder")}
            inputMode="numeric"
            required
            error={show(errors.timeError)}
            hint={t("admin.manualPunch.field.timeHint")}
          />
          <SelectField
            label={t("admin.manualPunch.field.direction")}
            value={direction}
            options={directions}
            onChange={(value) => setDirection(value as ManualPunchDirection)}
            hint={t("admin.manualPunch.field.directionHint")}
          />
        </div>

        <div className="mt-3">
          <Notice tone="info">{t("admin.manualPunch.firstLastRule")}</Notice>
        </div>
      </section>

      {/* ── 3 · Why ───────────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-sm font-semibold">{t("admin.manualPunch.step.why")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.manualPunch.step.whyHint")}
        </p>

        <div className="mt-3 space-y-1.5">
          <Label htmlFor="manual-punch-reason">
            {t("admin.manualPunch.field.reason")}
            <span className="ml-0.5 text-destructive">*</span>
          </Label>
          <textarea
            id="manual-punch-reason"
            value={reason}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("admin.manualPunch.field.reasonPlaceholder")}
            aria-describedby="manual-punch-reason-count"
            aria-invalid={showErrors && !reasonLongEnough}
            className={cn(
              "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              showErrors && !reasonLongEnough && "border-destructive",
            )}
          />
          <p id="manual-punch-reason-count" className="text-xs text-muted-foreground" aria-live="polite">
            {reasonLongEnough
              ? t("admin.manualPunch.reason.enough", { count: trimmedReason.length })
              : t("admin.manualPunch.reason.minLength", {
                  min: SENSITIVE_REASON_LENGTH,
                  count: trimmedReason.length,
                })}
          </p>
          {show(errors.reasonError) !== null ? (
            <p className="text-xs font-medium text-destructive" role="alert">
              {errors.reasonError}
            </p>
          ) : null}
        </div>
      </section>

      {/* ── 4 · Exactly what would be written ─────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-sm font-semibold">
          {t("admin.manualPunch.step.review")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.manualPunch.step.reviewHint")}
        </p>

        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <ReviewRow label={t("admin.manualPunch.review.person")}>
            {person === undefined
              ? dash(null)
              : t("admin.manualPunch.review.personValue", {
                  name: person.name,
                  code: person.code,
                })}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.istDate")}>
            {fmtCivilDateWeekday(istDateInput)}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.wallClock")}>
            {HHMM.test(timeInput.trim()) ? timeInput.trim() : dash(null)}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.instant")}>
            {instant === null ? dash(null) : fmtDateTime(instant)}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.direction")}>
            {punchDirectionLabel(direction)}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.source")}>
            {t("admin.punch.source.manualAdmin")}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.attributedTo")}>
            {actorName === null ? dash(null) : actorName}
          </ReviewRow>
          <ReviewRow label={t("admin.manualPunch.review.reason")}>
            {trimmedReason === "" ? dash(null) : trimmedReason}
          </ReviewRow>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!MANUAL_PUNCH_WRITE_AVAILABLE}
            onClick={() => setShowErrors(true)}
            title={
              MANUAL_PUNCH_WRITE_AVAILABLE
                ? undefined
                : t("admin.manualPunch.submitDisabledHint", { fn: MANUAL_PUNCH_FN })
            }
          >
            <ShieldAlert className="mr-2 size-4" aria-hidden />
            {t("admin.manualPunch.action.record")}
          </Button>
          <Button type="button" variant="outline" onClick={() => setShowErrors(true)}>
            {t("admin.manualPunch.action.check")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {isComplete
              ? t("admin.manualPunch.status.complete")
              : t("admin.manualPunch.status.incomplete")}
          </span>
        </div>

        {showErrors && !isComplete ? (
          <div className="mt-3">
            <Notice tone="warning">{t("admin.manualPunch.fixFirst")}</Notice>
          </div>
        ) : null}
      </section>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.manualPunch.footnote")}</p>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{children}</dd>
    </div>
  );
}
