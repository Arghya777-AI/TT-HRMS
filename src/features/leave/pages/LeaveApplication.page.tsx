/**
 * /me/leave/apply — how many days, which dates, where the days come from.
 *
 * IT REPLACES THE PREVIOUS APPLY SCREEN rather than sitting beside it. Shipping it at its own
 * path left two "apply for leave" links, which was reported immediately and was right: six
 * places link to `/me/leave/apply` and that is the one an employee finds. The old
 * `LeaveApply.page` is deleted, not orphaned.
 *
 * THE PER-DATE PREVIEW LOST IN THAT SWAP IS BACK, and by a better route. The old screen got it
 * by writing a draft and reading `calc_leave_days` off it; this one asks
 * `leave_countable_dates` (migration 040000), which answers for a range nobody has committed
 * to yet — so the dates that will be excluded are visible while the employee is still choosing
 * them, not after a draft exists.
 *
 * A RANGE, NOT A START DATE. This screen shipped with one date field and sent
 * `to_date = from_date`, which meant a three-day allocation filed three ONE-day requests whose
 * `total_days` could never match what was allocated. That was a real bug and the range is its
 * fix: `from_date` and `to_date` are both the employee's, and the calendar shows their own
 * weekly offs and holidays inside the selection.
 *
 * THE ORDER IS THE FEATURE. The existing form asks for dates and derives a length, which is
 * backwards for somebody who knows they want three days and has to work out which balances
 * cover them. This asks the number FIRST, then the dates, then the split — and it shows what
 * is left to allocate as they go, so the arithmetic is never theirs to do. The dates then
 * report back what they actually cost, and `rangeMismatch` says so when the two disagree
 * rather than quietly overriding either.
 *
 * ONE APPLICATION, SEVERAL TYPES, DISJOINT DATES. 0.5 from Week-off and 1.5 from Earned Leave
 * is one act here and becomes `leave_requests` rows sharing an `application_group_id`
 * (migration 039700). Each row is still guarded independently per type by the triggers around
 * `leave_requests`, including the per-type balance check — which is why this shape was chosen
 * over putting the leave type on the day.
 *
 * The rows get DIFFERENT dates, and that is forced, not stylistic: `leave_requests_no_overlap`
 * refuses a request whose date range touches another live one for the same employee. Giving
 * every type the same range — what this screen did — meant every two-type application was
 * refused. `splitAllocationsAcrossDates` deals the counted dates out instead.
 *
 * SICK LEAVE IS EXCLUSIVE AND THE FORM SAYS SO BEFORE SUBMIT. Choosing it clears any other
 * allocation and disables the rest, rather than letting somebody build an application the
 * database will refuse. The database refuses it too — `leave_requests_combination_guard`,
 * verified live: "Sick Leave must be taken on its own and cannot be combined with another
 * leave type". The screen is the courtesy; the trigger is the rule.
 *
 * NOTHING HERE COUNTS DAYS AGAINST A CALENDAR. Which dates are weekly offs or holidays comes
 * from the server both times: `leave_countable_dates` for the advisory preview, and
 * `calc_leave_days` for the `total_days` actually stamped on each filed request. The preview
 * is a read-only mirror of the engine's own day loop, verified against it over 279 date-by-date
 * comparisons. A browser copy would have been wrong immediately: TT0013's employee record says
 * WO-SUN-ALTSAT while `resolve_policy` — which the engine follows — says WO-MIDWEEK-TUE, so
 * reading the employee column marks Sunday free and Tuesday chargeable, backwards on both.
 *
 * @route /me/leave/apply
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, CheckCircle2, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { mutationUserMessage } from "@/shared/api/query";
import { blockerButtonProps, SubmitBlockers, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { fmtCivilDayMonthWeekday, nowIstDate } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useColleagues, useCountableDates, useMyLeaveContext } from "../hooks/useLeaveApply";
import { LeaveRangeCalendar } from "../components/LeaveRangeCalendar";
import {
  countedDatesOf,
  freeDayReason,
  rangeMismatch,
  rangeProblem,
  splitAllocationsAcrossDates,
  summariseRange,
  type RangeMismatch,
  type RangeProblem,
  type SplitProblem,
} from "../leaveRange";
import { useAllocatableTypes } from "../hooks/useAllocatableTypes";
import {
  allocationProblems,
  reasonRequired,
  remainingDays,
  singleTypeCap,
  suggestAllocation,
  type Allocation,
  type AllocationProblem,
  type SingleTypeCap,
} from "../leaveAllocation";
import {
  submitLeaveApplication,
  type LeaveApplicationResult,
} from "../api/leave-application.api";

/** Every problem, in a sentence the employee can act on. */
function problemText(problem: AllocationProblem): string {
  switch (problem.kind) {
    case "no_total":
      return t("leave.app.problem.noTotal");
    case "nothing_allocated":
      return t("leave.app.problem.nothing");
    case "under_allocated":
      return t("leave.app.problem.under", { days: formatNumber(problem.remaining) });
    case "over_allocated":
      return t("leave.app.problem.over", { days: formatNumber(problem.excess) });
    case "not_half_day":
      return t("leave.app.problem.halfStep", { type: problem.typeName });
    case "half_not_allowed":
      return t("leave.app.problem.noHalf", { type: problem.typeName });
    case "insufficient":
      return t("leave.app.problem.insufficient", {
        type: problem.typeName,
        available: formatNumber(problem.available),
      });
    case "below_minimum":
      return t("leave.app.problem.minimum", {
        type: problem.typeName,
        min: formatNumber(problem.minimum),
      });
    case "exclusive":
      return t("leave.app.problem.exclusive", { type: problem.typeName });
  }
}

/** Why the chosen range cannot be priced, in a sentence. */
function rangeProblemText(problem: RangeProblem): string {
  switch (problem.kind) {
    case "incomplete":
      return t("leave.app.range.problem.incomplete");
    case "inverted":
      return t("leave.app.range.problem.inverted");
    case "tooLong":
      return t("leave.app.range.problem.tooLong", { days: formatNumber(problem.days) });
  }
}

/**
 * The dates cannot be dealt out across the chosen types. The only way this happens is two
 * half days of different types wanting the same date — a date cannot carry two requests past
 * `leave_requests_no_overlap` — so the sentence says what to do about it.
 */
function splitProblemText(problem: SplitProblem): string {
  return t("leave.app.range.problem.notEnoughDates", {
    needed: formatNumber(problem.datesNeeded),
    available: formatNumber(problem.datesAvailable),
  });
}

/**
 * The dates and the split disagree. Both numbers are named, because the employee has to decide
 * which of the two to change and cannot without seeing them.
 */
function mismatchText(mismatch: RangeMismatch): string {
  const args = {
    counted: formatNumber(mismatch.counted),
    allocated: formatNumber(mismatch.allocated),
  };
  return mismatch.kind === "allocatedMore"
    ? t("leave.app.range.mismatchMore", args)
    : t("leave.app.range.mismatchLess", args);
}

export default function LeaveApplicationPage() {
  const contextQuery = useMyLeaveContext();
  const context = contextQuery.data ?? null;
  const { types, isPending, error: typesError } = useAllocatableTypes(context);
  const colleagues = useColleagues();

  /* Never yourself: naming yourself as cover is meaningless, and the server records it. */
  const coverChoices = useMemo(
    () => (colleagues.data ?? []).filter((c) => c.id !== context?.id),
    [colleagues.data, context],
  );

  const [totalDays, setTotalDays] = useState("1");
  const [fromDate, setFromDate] = useState(nowIstDate());
  const [toDate, setToDate] = useState(nowIstDate());
  /*
    ── ONE PANEL, AND EVERY ROW KNOWS ITS CEILING ────────────────────────────

    A "pick one type first" mode was built here and then removed: putting all
    five days on a single row IS one type, so the mode was a second way to say
    the same thing, and two ways to say one thing is what made this screen
    confusing to begin with.

    What the attempt did surface is the part that was genuinely missing. Somebody
    holding one sick day who asked for two got "1 still to place" and no way
    forward — correct, and useless. Now each row carries its own ceiling, cannot
    be pushed past it, and a total that cannot be placed offers the number that
    can.
  */
  const [allocations, setAllocations] = useState<readonly Allocation[]>([]);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [handoverId, setHandoverId] = useState("");
  const [handoverNotes, setHandoverNotes] = useState("");
  const [addressAway, setAddressAway] = useState("");
  const [mentioned, setMentioned] = useState<readonly string[]>([]);
  /*
    The shared attempt state — see `SubmitBlockers`. This page had the first copy
    of it; seven other forms then needed the same behaviour, so it moved into one
    file rather than being pasted eight times with eight small differences.
  */
  const attempt = useSubmitAttempt();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<LeaveApplicationResult | null>(null);

  const total = Number.parseFloat(totalDays) || 0;

  /*
    THE CEILING PER TYPE.

    "employee can take maximum leave that are available only, leave balance can't
    be negative" — so a paid balance is a hard limit on its row, and the monthly
    ceiling (`max_days_per_month`, migration 041600) binds alongside it.
    `singleTypeCap` picks the tighter of the two and says which, so the message
    quotes the number the employee can act on.

    `allocationProblems` already refuses an over-balance allocation; this adds the
    monthly half, which it has no way to know about.
  */
  const caps = useMemo(() => {
    const map = new Map<string, SingleTypeCap>();
    for (const type of types) {
      const cap = singleTypeCap(type);
      if (cap !== null) map.set(type.id, cap);
    }
    return map;
  }, [types]);

  const overCaps = useMemo(
    () =>
      allocations.flatMap((a) => {
        const cap = caps.get(a.typeId);
        const type = types.find((candidate) => candidate.id === a.typeId);
        if (cap === undefined || type === undefined || a.days <= cap.days) return [];
        return [{ type, cap }];
      }),
    [allocations, caps, types],
  );

  const remaining = remainingDays(total, allocations);
  const problems = allocationProblems(total, allocations, types);
  /* ── The range, and what it costs ──────────────────────────────────────────
     `rangeProblem` is answered without the server so an inverted range costs no round trip;
     `countable` is the server's per-date verdict and `summary` is arithmetic over it. */
  const badRange = rangeProblem(fromDate, toDate);
  const countable = useCountableDates(fromDate, toDate);
  const summary = useMemo(() => summariseRange(countable.data ?? []), [countable.data]);
  const mismatch = rangeMismatch(summary.countedDays, total);

  /* The dates each type will actually carry. Computed here rather than at submit so a split
     that cannot be made is shown BEFORE the button is pressed — two half days of different
     types need two dates and the overlap guard would otherwise refuse the second request. */
  const split = useMemo(
    () => splitAllocationsAcrossDates(countedDatesOf(summary.dates), allocations),
    [summary.dates, allocations],
  );

  /* Submitting over a range the allocation does not match would hand the employee a refusal
     with a number this screen never showed them — `total_days` is stamped from the DATES. */
  /*
    WHO HAS TO SAY WHY.

    This used to demand ten characters from everybody, because `ck_lr__reason`
    did. Migration 041600 moved that rule onto the TYPE — `requires_reason`, true
    for Sick Leave and false for the rest — and `trg_leave_requests__submit_rules`
    is what enforces it now. So the form asks only when something chosen asks.
  */
  const needsReason = useMemo(() => reasonRequired(allocations, types), [allocations, types]);

  /*
    WHY THE BUTTON IS OFF, IN WORDS.

    `ready` was seven predicates and the button was simply disabled when any of
    them failed. Every one has a message SOMEWHERE on the screen — under the date
    fields, in the warning list beside the balances — but a reason five fields
    away from a disabled button is a reason nobody connects to it. Reported as
    "why send for approval is not working", with a five-character reason typed
    against sick leave, which needs ten.

    So the list and the button are built from the same array. A blocker missing
    from this list cannot disable the button, and a disabled button always has
    something to point at.
  */
  const blockers: string[] = [];
  if (total <= 0) blockers.push(t("leave.app.blocked.noDays"));
  if (badRange !== null) blockers.push(rangeProblemText(badRange));
  if (mismatch !== null) blockers.push(mismatchText(mismatch));
  for (const { type, cap } of overCaps) {
    blockers.push(
      cap.reason === "balance"
        ? t("leave.app.cap.balance", { type: type.name, days: formatNumber(cap.days) })
        : t("leave.app.cap.monthly", { type: type.name, days: formatNumber(cap.days) }),
    );
  }
  /* `canSubmitAllocation` is exactly `allocationProblems(...).length === 0`, so
     walking the problems here is the same test — stated once instead of twice. */
  for (const problem of problems) blockers.push(problemText(problem));
  /*
    NO COVER BLOCKER. Migration 042200 removed the server rule that demanded a
    named colleague in an operational department — "don't make mandatory who is
    covering" — so the form must not demand it either. The field stays, unstarred,
    because filling it in is still the decent thing to do.
  */
  if (needsReason && reason.trim().length < 10) {
    blockers.push(t("leave.app.blocked.reason", { n: String(reason.trim().length) }));
  }
  if (split.problem !== null) blockers.push(splitProblemText(split.problem));
  if (total > 0 && split.segments.length === 0) blockers.push(t("leave.app.blocked.noSegments"));

  /*
    `ready` is gone: the button no longer consults it. `blockers` IS the answer —
    empty means send, non-empty means show the box — and a second boolean saying
    the same thing is a second thing that can disagree with it.
  */

  /** Unpaid leave, if the venue has such a type — what a shortfall can be taken as. */
  const lwpType = useMemo(() => types.find((type) => !type.isPaid) ?? null, [types]);

  /** The exclusive type currently chosen, if any — it locks the rest of the list. */
  const exclusiveChosen = useMemo(() => {
    const used = allocations.filter((a) => a.days > 0).map((a) => a.typeId);
    return types.find((type) => used.includes(type.id) && !type.allowsCombination) ?? null;
  }, [allocations, types]);

  function setDays(typeId: string, days: number): void {
    setFailure(null);
    const type = types.find((candidate) => candidate.id === typeId);
    // Choosing an exclusive type replaces the whole split rather than adding to it — the
    // database would refuse the mix, so the form must not let one be assembled.
    if (type !== undefined && !type.allowsCombination && days > 0) {
      setAllocations([{ typeId, days }]);
      return;
    }
    setAllocations((prev) => {
      const withoutExclusive = prev.filter((a) => {
        const other = types.find((candidate) => candidate.id === a.typeId);
        return other === undefined || other.allowsCombination;
      });
      const rest = withoutExclusive.filter((a) => a.typeId !== typeId);
      return days > 0 ? [...rest, { typeId, days }] : rest;
    });
  }

  function daysFor(typeId: string): number {
    return allocations.find((a) => a.typeId === typeId)?.days ?? 0;
  }

  function submit(): void {
    if (context === null) return;
    setBusy(true);
    setFailure(null);
    /*
      ONE MEMBER PER SEGMENT, WITH DISJOINT DATES. Not one member per type over the shared
      range: `leave_requests_no_overlap` refuses a request whose dates touch another live one
      for the same employee, so two types over the same range meant the second was always
      rejected. `split` deals the counted dates out — see `splitAllocationsAcrossDates`.
    */
    const members = split.segments.map((segment) => {
      const type = types.find((candidate) => candidate.id === segment.typeId);
      return {
        leaveTypeId: segment.typeId,
        leaveTypeName: type?.name ?? "",
        fromDate: segment.fromDate,
        toDate: segment.toDate,
        portion: segment.portion as "full_day" | "first_half" | "second_half",
      };
    });

    void submitLeaveApplication({
      employeeId: context.id,
      members,
      reason: reason.trim(),
      contactDuringLeave: contact.trim() === "" ? null : contact.trim(),
      addressDuringLeave: addressAway.trim() === "" ? null : addressAway.trim(),
      handoverToEmployeeId: handoverId === "" ? null : handoverId,
      handoverNotes: handoverNotes.trim() === "" ? null : handoverNotes.trim(),
      mentionEmployeeIds: mentioned,
    })
      .then((result) => {
        setDone(result);
        setAllocations([]);
        setReason("");
        attempt.reset();
      })
      .catch((err: unknown) => setFailure(mutationUserMessage(err)))
      .finally(() => setBusy(false));
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarPlus}
        title={t("leave.app.title")}
        subtitle={t("leave.app.subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/me/leave">{t("leave.app.myLeave")}</Link>
          </Button>
        }
      />

      {done !== null ? (
        <div className="mb-5 rounded-lg border border-success/40 bg-success/5 p-4">
          <p className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("leave.app.done", { n: formatNumber(done.filed.length) })}
          </p>
          <ul className="mt-2 space-y-0.5 text-sm">
            {done.filed.map((member) => (
              <li key={member.requestId}>
                {member.requestNumber} · {member.leaveTypeName}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failure !== null ? (
        <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">{t("leave.app.refused")}</p>
          <p className="mt-1">{failure}</p>
        </div>
      ) : null}

      <StateBoundary
        loading={isPending || contextQuery.isPending}
        error={typesError ?? contextQuery.error}
        onRetry={() => void contextQuery.refetch()}
        skeletonRows={4}
      >
        {/*
          STEPS 1 AND 2 SIT SIDE BY SIDE, the balances in a narrow column beside the calendar.
          Stacked, the calendar pushed "where should these days come from?" off the bottom of the
          screen — so choosing dates and choosing balances, which are decided against each other,
          could not be seen at once. The balance column is deliberately the narrow one: each row
          is a name and a number, while the calendar has a fixed minimum width it cannot go below.

          One column below `xl`, because seven date cells plus a balance list do not fit a laptop
          width, let alone a phone.
        */}
        {/* `[&>*]:min-w-0` on the items too: a grid item defaults to `min-width: auto`, which
            floors it at its content's min-content width — at 320px the step-1 card measured
            358px and pushed the page sideways even though every box inside it could wrap. */}
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)] [&>*]:min-w-0">
          {/* ── 1. How many days ────────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold">{t("leave.app.step1")}</h2>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-muted-foreground">{t("leave.app.days")}</span>
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={totalDays}
                  onChange={(event) => {
                    setTotalDays(event.target.value);
                    setAllocations([]);
                  }}
                  className="num h-10 w-28 rounded-md border bg-background px-3 text-lg font-semibold tabular-nums"
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={total <= 0}
                onClick={() => setAllocations(suggestAllocation(total, types))}
              >
                {t("leave.app.suggest")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("leave.app.daysHint")}</p>

            {/* ── The dates ────────────────────────────────────────────────────
                Typed fields AND a calendar, both writing the same two pieces of state. The
                fields are faster for anyone who knows the dates; the calendar is the only
                thing that can show a weekly off before it is chosen. */}
            <div className="mt-4 border-t pt-4">
              <h3 className="text-xs font-semibold">{t("leave.app.range.title")}</h3>
              <div className="mt-2 grid gap-4 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium text-muted-foreground">
                        {t("leave.app.range.from")}
                      </span>
                      <input
                        type="date"
                        value={fromDate}
                        onChange={(event) => setFromDate(event.target.value)}
                        className="h-10 rounded-md border bg-background px-3 text-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium text-muted-foreground">
                        {t("leave.app.range.to")}
                      </span>
                      <input
                        type="date"
                        value={toDate}
                        min={fromDate}
                        onChange={(event) => setToDate(event.target.value)}
                        className="h-10 rounded-md border bg-background px-3 text-sm"
                      />
                    </label>
                  </div>
                  <div className="mt-3">
                    <LeaveRangeCalendar
                      fromDate={fromDate}
                      toDate={toDate}
                      onChange={(nextFrom, nextTo) => {
                        setFromDate(nextFrom);
                        setToDate(nextTo);
                      }}
                    />
                  </div>
                </div>

                {/* ── What these dates actually cost ───────────────────────── */}
                <div className="min-w-0">
                  {badRange !== null ? (
                    <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                      {rangeProblemText(badRange)}
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <p className="num text-2xl font-semibold tabular-nums">
                          {countable.isPending
                            ? "—"
                            : t("leave.app.range.counted", {
                                days: formatNumber(summary.countedDays),
                              })}
                        </p>
                        {summary.dates.length > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("leave.app.range.countedOf", {
                              counted: formatNumber(summary.countedDays),
                              span: formatNumber(summary.dates.length),
                            })}
                          </p>
                        ) : null}
                      </div>

                      <p className="mt-1 text-xs text-muted-foreground">
                        {summary.dates.length === 0
                          ? ""
                          : summary.freeDays === 0
                            ? t("leave.app.range.freeNone")
                            : t("leave.app.range.freeSome", {
                                free: formatNumber(summary.freeDays),
                                weeklyOffs: formatNumber(summary.weeklyOffs),
                                holidays: formatNumber(summary.holidays),
                              })}
                      </p>

                      {split.problem !== null ? (
                        <p className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                          {splitProblemText(split.problem)}
                        </p>
                      ) : null}

                      {mismatch !== null ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                          <span className="min-w-0 flex-1">{mismatchText(mismatch)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setTotalDays(String(summary.countedDays));
                              setAllocations([]);
                            }}
                          >
                            {t("leave.app.range.useCounted", {
                              days: formatNumber(summary.countedDays),
                            })}
                          </Button>
                        </div>
                      ) : null}

                      {/* Which dates each type will carry. Shown because the split is not
                          obvious and the employee is entitled to see it before it is filed —
                          these become separate requests with separate numbers. */}
                      {split.segments.length > 1 ? (
                        <div className="mt-3 rounded-md border bg-muted/30 p-2.5">
                          <p className="text-xs font-medium">{t("leave.app.range.perType")}</p>
                          <ul className="mt-1 space-y-0.5 text-xs">
                            {split.segments.map((segment, index) => (
                              <li
                                key={`${segment.typeId}-${segment.fromDate}-${index}`}
                                className="flex flex-wrap items-baseline justify-between gap-x-2"
                              >
                                <span className="font-medium">
                                  {types.find((type) => type.id === segment.typeId)?.name ??
                                    segment.typeId}
                                </span>
                                <span className="text-muted-foreground">
                                  {segment.fromDate === segment.toDate
                                    ? fmtCivilDayMonthWeekday(segment.fromDate)
                                    : `${fmtCivilDayMonthWeekday(segment.fromDate)} – ${fmtCivilDayMonthWeekday(segment.toDate)}`}
                                  {" · "}
                                  {t("leave.app.range.segmentDays", {
                                    days: formatNumber(segment.expectedDays),
                                  })}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-[0.65rem] text-muted-foreground">
                            {t("leave.app.range.perTypeHint")}
                          </p>
                        </div>
                      ) : null}

                      {/* The per-date list — the preview the old screen had, now shown before
                          anything is filed rather than after. */}
                      {summary.dates.length > 0 ? (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("leave.app.range.perDate")}
                          </p>
                          <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1 text-xs">
                            {summary.dates.map((day) => {
                              const reason = freeDayReason(day);
                              return (
                                <li
                                  key={day.leave_date}
                                  className={cn(
                                    "flex items-baseline justify-between gap-2 rounded px-1.5 py-0.5",
                                    reason === null ? "" : "text-muted-foreground",
                                  )}
                                >
                                  <span>{fmtCivilDayMonthWeekday(day.leave_date)}</span>
                                  <span className="shrink-0">
                                    {reason === null
                                      ? "1"
                                      : reason === "weekly_off"
                                        ? `${t("leave.app.range.weeklyOff")} · ${t("leave.app.range.notCounted")}`
                                        : `${day.holiday_name ?? t("leave.app.range.holiday")} · ${t("leave.app.range.notCounted")}`}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ── 2. Where the days come from ───────────────────────────────────
              ONE PANEL, NOT TWO MODES. A "pick one type" mode was built and then
              removed: allocating all five days to a single row IS one type, so
              the mode was a second way to say the same thing — and two ways to
              say one thing is what made the screen confusing in the first place.

              What survived from that attempt is the part that was actually
              missing: every row states its ceiling, no row can be pushed past it,
              and a request that cannot be placed offers the number that can. */}
          <section className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-sm font-semibold">{t("leave.app.step2")}</h2>
                <p
                  className={cn(
                    "num text-sm font-semibold tabular-nums",
                    remaining === 0 ? "text-success" : remaining < 0 ? "text-destructive" : "text-warning",
                  )}
                >
                  {remaining === 0
                    ? t("leave.app.allPlaced")
                    : remaining > 0
                      ? t("leave.app.leftToPlace", { days: formatNumber(remaining) })
                      : t("leave.app.overBy", { days: formatNumber(-remaining) })}
                </p>
              </div>

              {/*
                TAKE THE SHORTFALL AS LOSS OF PAY. Unpaid leave has no balance to run out of, so
                this is the honest escape when the paid balances do not cover the request — and it
                is a deliberate button rather than something the suggester does silently, because
                it costs the employee money.
              */}
              {remaining > 0 && lwpType !== null && exclusiveChosen === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setDays(lwpType.id, daysFor(lwpType.id) + remaining)}
                >
                  {t("leave.app.takeLwp", { days: formatNumber(remaining) })}
                </Button>
              ) : null}

              {exclusiveChosen !== null ? (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t("leave.app.exclusiveLock", { type: exclusiveChosen.name })}
                </p>
              ) : null}

              <ul className="mt-3 space-y-2">
                {types.map((type) => {
                  const chosen = daysFor(type.id);
                  const locked = exclusiveChosen !== null && exclusiveChosen.id !== type.id;
                  const empty = type.isPaid && type.availableDays <= 0;
                  return (
                    <li
                      key={type.id}
                      className={cn(
                        "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2",
                        chosen > 0 ? "border-primary bg-primary/5" : "bg-background/60",
                        (locked || empty) && "opacity-50",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{type.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {type.isPaid
                            ? t("leave.app.available", { days: formatNumber(type.availableDays) })
                            : t("leave.app.unpaid")}
                          {!type.allowsCombination ? ` · ${t("leave.app.mustBeAlone")}` : ""}
                          {/*
                            STATED, NOT ENFORCED HERE. Knowing how much of the
                            month's ceiling is already spent needs a read this form
                            does not make, and a ceiling half-checked in the
                            browser is worse than one named plainly:
                            `trg_leave_requests__submit_rules` refuses with the
                            month and the days already booked in it.
                          */}
                          {type.maxDaysPerMonth !== null
                            ? ` · ${t("leave.app.monthlyCap", {
                                days: formatNumber(type.maxDaysPerMonth),
                              })}`
                            : ""}
                        </span>
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        /*
                          THE ROW'S OWN CEILING. A balance cannot go negative and
                          a month has a limit, so the stepper stops at whichever
                          is tighter. `overCaps` below is what refuses a number
                          typed straight in — `max` alone is advisory in every
                          browser.
                        */
                        {...(caps.has(type.id)
                          ? { max: String(caps.get(type.id)?.days ?? 0) }
                          : {})}
                        value={chosen === 0 ? "" : String(chosen)}
                        placeholder="0"
                        disabled={locked || empty || busy}
                        onChange={(event) =>
                          setDays(type.id, Number.parseFloat(event.target.value) || 0)
                        }
                        aria-label={t("leave.app.daysFrom", { type: type.name })}
                        className="num h-9 w-16 shrink-0 rounded-md border bg-background px-2 text-right tabular-nums"
                      />
                    </li>
                  );
                })}
              </ul>
          </section>
        </div>

        {/* ── 3. Why ──────────────────────────────────────────────────────── */}
        <section className="mt-4 rounded-lg border bg-card p-4">
          <h2 className="font-display text-sm font-semibold">{t("leave.app.step3")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">
                {needsReason ? t("leave.app.reason") : t("leave.app.reason.optional")}
              </span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
                placeholder={t("leave.app.reasonPlaceholder")}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
              <span className="text-muted-foreground">
                {needsReason ? t("leave.app.reasonHint") : t("leave.app.reasonHint.optional")}
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("leave.app.contact")}</span>
              <input
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                disabled={busy}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
            </label>
            {/* Required for operational departments — the server refuses without it, so it is
                offered rather than left for the refusal to explain. */}
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("leave.app.coveredBy")}</span>
              {/*
                `w-full min-w-0` is load-bearing, not tidying. A <select> sizes itself to its
                LONGEST OPTION and will not go below it, and these options are
                "Name · Designation" for every colleague — so on a 390px phone this one control
                made the whole step 408px wide and the page scrolled sideways, dragging the
                fixed bottom nav out of line. With `min-w-0` it shrinks and the option text is
                clipped by the control, which is how a native select is meant to behave.
              */}
              <select
                value={handoverId}
                onChange={(event) => setHandoverId(event.target.value)}
                disabled={busy || colleagues.isPending}
                className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{t("leave.app.coveredByNone")}</option>
                {coverChoices.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.display_name}
                    {person.designation_name === null ? "" : ` · ${person.designation_name}`}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">{t("leave.app.coveredByHint")}</span>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("leave.app.address")}</span>
              <input
                value={addressAway}
                onChange={(event) => setAddressAway(event.target.value)}
                disabled={busy}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
            </label>
            {/* Mention peers. Each one is notified once, by the database trigger. */}
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t("leave.app.mention")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("leave.app.mentionHint")}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {coverChoices.slice(0, 40).map((person) => {
                  const on = mentioned.includes(person.id);
                  return (
                    <button
                      key={person.id}
                      type="button"
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() =>
                        setMentioned((prev) =>
                          on ? prev.filter((id) => id !== person.id) : [...prev, person.id],
                        )
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-background hover:border-primary/60",
                      )}
                    >
                      {person.display_name}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">{t("leave.app.handover")}</span>
              <input
                value={handoverNotes}
                onChange={(event) => setHandoverNotes(event.target.value)}
                disabled={busy}
                placeholder={t("leave.app.handoverPlaceholder")}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
            </label>
          </div>
        </section>

        {/* Everything wrong, all of it, before they press anything. */}
        {(problems.length > 0 || overCaps.length > 0) && total > 0 ? (
          <ul className="mt-4 space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
            {overCaps.map(({ type, cap }) => (
              <li key={`cap-${type.id}`}>
                {cap.reason === "balance"
                  ? t("leave.app.cap.balance", {
                      type: type.name,
                      days: formatNumber(cap.days),
                    })
                  : t("leave.app.cap.monthly", {
                      type: type.name,
                      days: formatNumber(cap.days),
                    })}
              </li>
            ))}
            {problems.map((problem, i) => (
              <li key={`${problem.kind}-${String(i)}`}>{problemText(problem)}</li>
            ))}
          </ul>
        ) : null}

        {/*
          THE WAY OUT OF "STILL TO PLACE".

          This is the state that was reported: two days asked for, one sick day
          held, sick leave cannot be combined — so nothing could absorb the
          second day and the screen simply stopped. Refusing without offering the
          number that WOULD work is the defect; this offers it.

          Only when something HAS been placed: with nothing placed there is no
          number to fall back to, and "ask for 0 days" is not an offer.
        */}
        {remaining > 0 && total - remaining > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/50 bg-warning/5 p-3 text-xs">
            <span className="min-w-0 flex-1">
              {t("leave.app.reduce.hint", {
                asked: formatNumber(total),
                placed: formatNumber(total - remaining),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTotalDays(String(total - remaining))}
            >
              {t("leave.app.reduce.action", { days: formatNumber(total - remaining) })}
            </Button>
          </div>
        ) : null}

        <SubmitBlockers
          attempt={attempt}
          blockers={blockers}
          id="leave-app-blockers"
          title={t("leave.app.blocked.title")}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy}
            {...blockerButtonProps(attempt, blockers, "leave-app-blockers")}
            onClick={() => {
              if (!attempt.press(blockers)) return;
              submit();
            }}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {t("leave.app.submit")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("leave.app.submitHint")}</span>
        </div>
      </StateBoundary>
    </div>
  );
}
