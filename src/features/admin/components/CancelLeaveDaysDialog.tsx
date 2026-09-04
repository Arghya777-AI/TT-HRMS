/**
 * Look at a leave, then cancel all of it or the days you pick.
 *
 * ── TWO STEPS, AND THE FIRST ONE IS READ-ONLY ────────────────────────────────
 * Clicking a name on a calendar means "show me this", not "let me start unpicking it". The
 * first step is therefore the booking as it stands — every day, the type, what it cost — with
 * nothing checked and nothing to submit. Only pressing Cancel moves to the picker.
 *
 * Opening straight into a form full of ticked boxes is how somebody cancels a leave they only
 * meant to read.
 *
 * ── WHY A DAY PICKER AND NOT A CONFIRM ───────────────────────────────────────
 * A three-day booking is rarely wrong in all three. Somebody asks for Monday to Wednesday,
 * comes back on the Tuesday, and the venue wants Tuesday released and the rest left alone.
 * Cancelling the whole request and asking them to re-apply loses the approval trail and the
 * notice period, and re-files paperwork nobody disputed.
 *
 * So the dialog lists every day of the request with a box against it, all ticked, and the
 * administrator unticks what stays. Ticking all of them is the ordinary case and is one
 * click away — "Select all" — so the common path costs nothing.
 *
 * ── THE ROWS THAT COST NOTHING ARE STILL SHOWN ───────────────────────────────
 * A holiday or a weekly off falling inside the range is stored as a day row with
 * `is_counted = false`: it is part of the booking and costs no balance. Those are rendered
 * greyed and marked, not hidden. A three-day request spanning a Sunday is three rows on the
 * calendar, and an administrator who saw two here would reasonably think a day had gone
 * missing.
 *
 * A day that is already cancelled is shown struck through and cannot be picked again — the
 * server refuses it anyway, but a box that does nothing is worse than no box.
 */
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, CalendarX, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { cn } from "@/lib/utils";
import { fmtCivilDayMonthWeekday, istToday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useCancelLeaveDays, useLeaveRequestDays } from "../hooks/useAdminLeave";

export interface CancelLeaveDaysDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Null closes the dialog; a value opens it on that request. */
  readonly requestId: string | null;
  readonly requestNumber: string;
  /** Whose leave it is, so the title names a person rather than a number. */
  readonly employeeName: string | null;
  readonly onDone: (message: string) => void;
}

export function CancelLeaveDaysDialog({
  open,
  onOpenChange,
  requestId,
  requestNumber,
  employeeName,
  onDone,
}: CancelLeaveDaysDialogProps): React.JSX.Element {
  const days = useLeaveRequestDays(open ? requestId : null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [reason, setReason] = useState("");
  /*
    ── A DAY THAT HAS ALREADY HAPPENED ────────────────────────────────────────
    Cancelling a FUTURE leave is planning. Cancelling one that has already passed rewrites
    history: the employee was absent that day and the record is about to say they were not,
    which changes an attendance day somebody may already have acted on.
    That is not a thing to do by reflex, so it must be acknowledged before the button works.
  */
  const [acknowledged, setAcknowledged] = useState(false);
  /** "view" is the booking as it stands; "cancel" is the picker. Always opens on "view". */
  const [step, setStep] = useState<"view" | "cancel">("view");

  const cancellable = useMemo(
    () => (days.data ?? []).filter((d) => d.status === "approved"),
    [days.data],
  );

  /*
    Everything ticked when the list arrives, because cancelling the whole booking is the
    ordinary case. Keyed on the request so reopening on a different one does not inherit the
    previous selection.
  */
  useEffect(() => {
    setPicked(cancellable.map((d) => d.leave_date));
    setReason("");
    // Re-armed for every request: an acknowledgement is for the days in front of you.
    setAcknowledged(false);
    setStep("view");
  }, [cancellable, requestId]);

  const cancel = useCancelLeaveDays((input, result) => {
    onOpenChange(false);
    onDone(
      result.days_remaining > 0
        ? t("adminLeave.cancelDays.donePartial", {
          n: String(result.days_cancelled),
          number: input.requestNumber,
          left: String(result.days_remaining),
        })
        : t("adminLeave.cancelDays.doneAll", { number: input.requestNumber }),
    );
  });

  const toggle = (date: string): void =>
    setPicked((prev) =>
      prev.includes(date) ? prev.filter((d) => d !== date) : [...prev, date],
    );

  const reasonOk = reason.trim().length >= SENSITIVE_REASON_LENGTH;
  /*
    Compared as IST civil dates, never against a browser clock. `istToday()` is the venue's
    day; `new Date()` on a laptop set to another timezone would call this morning "past"
    somewhere and "future" somewhere else, on the same record.
  */
  const today = istToday();
  const pastPicked = picked.filter((d) => d < today);
  const needsAck = pastPicked.length > 0;
  const canSubmit =
    picked.length > 0 && reasonOk && (!needsAck || acknowledged) && !cancel.isPending;
  const releasing = cancellable
    .filter((d) => picked.includes(d.leave_date))
    .reduce((sum, d) => sum + (d.is_counted ? Number(d.day_value) : 0), 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bark/50 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
            "max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-lg",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <CalendarX className="size-5 text-destructive" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="font-display text-base font-semibold">
                {t("adminLeave.cancelDays.title", {
                  name: employeeName ?? t("admin.common.unknownPerson"),
                })}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {t("adminLeave.cancelDays.body", { number: requestNumber })}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t("adminLeave.cancelDays.close")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          <StateBoundary
            loading={days.isPending}
            error={days.error}
            onRetry={() => void days.refetch()}
            skeletonRows={3}
          >
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(step === "view" ? "adminLeave.cancelDays.days" : "adminLeave.cancelDays.pick")}
                </span>
                {step === "cancel" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPicked(
                      picked.length === cancellable.length
                        ? []
                        : cancellable.map((d) => d.leave_date),
                    )
                  }
                >
                    {picked.length === cancellable.length
                      ? t("adminLeave.cancelDays.selectNone")
                      : t("adminLeave.cancelDays.selectAll")}
                  </Button>
                ) : null}
              </div>

              <ul className="divide-y rounded-lg border">
                {(days.data ?? []).map((d) => {
                  const done = d.status !== "approved";
                  const free = !d.is_counted;
                  return (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                      {/* Nothing to tick while you are only looking at it. */}
                      {step === "cancel" ? (
                        <input
                          type="checkbox"
                          id={`day-${d.id}`}
                          checked={picked.includes(d.leave_date)}
                          disabled={done}
                          onChange={() => toggle(d.leave_date)}
                          className="size-4 shrink-0 accent-destructive"
                        />
                      ) : null}
                      <label
                        htmlFor={`day-${d.id}`}
                        className={cn(
                          "flex-1 text-sm",
                          done && "text-muted-foreground line-through",
                        )}
                      >
                        {fmtCivilDayMonthWeekday(d.leave_date)}
                        {d.portion !== "full_day" ? (
                          <span className="ml-1.5 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">
                            {t("adminLeave.cancelDays.halfDay")}
                          </span>
                        ) : null}
                        {/* Stored, part of the booking, and costs no balance. Said, not hidden. */}
                        {free && !done ? (
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            {t(
                              d.is_holiday
                                ? "adminLeave.cancelDays.holiday"
                                : "adminLeave.cancelDays.weeklyOff",
                            )}
                          </span>
                        ) : null}
                      </label>
                      <span className="num shrink-0 text-xs tabular-nums text-muted-foreground">
                        {free ? "—" : Number(d.day_value).toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-2 text-xs text-muted-foreground">
                {step === "view"
                  ? t("adminLeave.cancelDays.totals", {
                    days: (days.data ?? [])
                      .reduce((sum, d) => sum + (d.is_counted ? Number(d.day_value) : 0), 0)
                      .toFixed(2),
                    n: String(cancellable.length),
                  })
                  : t("adminLeave.cancelDays.releasing", { days: releasing.toFixed(2) })}
              </p>
            </div>

            {step === "cancel" ? (
            <div className="mt-4">
              <label htmlFor="cancel-days-reason" className="block text-sm font-medium">
                {t("adminLeave.cancelDays.reasonLabel")}
              </label>
              <textarea
                id="cancel-days-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
                className="mt-1.5 w-full rounded-md border bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p
                className={cn(
                  "mt-1 text-xs tabular-nums",
                  reasonOk ? "text-success" : "text-muted-foreground",
                )}
              >
                {t("adminLeave.cancelDays.counter", {
                  n: String(reason.trim().length),
                  min: String(SENSITIVE_REASON_LENGTH),
                })}
              </p>
            </div>
            ) : null}

            {/*
              ── THE WARNING, AND THE OK ─────────────────────────────────────
              Shown only when a picked day is already behind us, and it blocks the button
              until it is acknowledged. It names the dates rather than saying "some days",
              because the administrator may have ticked a range without noticing that two of
              them were last week.
            */}
            {step === "cancel" && needsAck ? (
              <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-3">
                <p className="flex items-start gap-2 text-xs font-medium text-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {t("adminLeave.cancelDays.pastWarning", {
                    dates: pastPicked
                      .slice()
                      .sort()
                      .map((d) => fmtCivilDayMonthWeekday(d))
                      .join(", "),
                  })}
                </p>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="size-4 shrink-0 accent-warning"
                  />
                  {t("adminLeave.cancelDays.pastAck")}
                </label>
              </div>
            ) : null}

            {/*
              The database's refusals — a locked period, a leave already paid, comp-off booked
              whole — arrive here and are shown rather than swallowed. Each names something the
              administrator has to go and do.
            */}
            {cancel.userMessage !== undefined ? (
              <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {cancel.userMessage}
              </p>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {step === "view" ? (
                <>
                  {/*
                    The way OUT of read-only. Destructive styling starts here rather than on
                    the row that opened the dialog: clicking a name on a calendar is a look,
                    and only this is a decision.
                  */}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={cancellable.length === 0}
                    onClick={() => setStep("cancel")}
                  >
                    {t("adminLeave.cancelDays.startCancel")}
                  </Button>
                  <Dialog.Close asChild>
                    <Button type="button" variant="ghost" size="sm">
                      {t("adminLeave.cancelDays.close")}
                    </Button>
                  </Dialog.Close>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={!canSubmit}
                    onClick={() => {
                      if (requestId === null) return;
                      cancel.save({ requestId, requestNumber, dates: picked }, reason.trim());
                    }}
                  >
                    {cancel.isPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                    ) : null}
                    {picked.length === cancellable.length && cancellable.length > 0
                      ? t("adminLeave.cancelDays.confirmAll")
                      : t("adminLeave.cancelDays.confirmSome", { n: String(picked.length) })}
                  </Button>
                  {/* Back to looking, without closing and losing the fetch. */}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setStep("view")}>
                    {t("adminLeave.cancelDays.back")}
                  </Button>
                </>
              )}
            </div>

          </StateBoundary>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
