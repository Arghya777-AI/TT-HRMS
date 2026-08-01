/**
 * /me/leave/apply-combined — how many days, which dates, where the days come from.
 *
 * THE ORDER IS THE FEATURE. The existing form asks for dates and derives a length, which is
 * backwards for somebody who knows they want three days and has to work out which balances
 * cover them. This asks the number FIRST, then the dates, then the split — and it shows what
 * is left to allocate as they go, so the arithmetic is never theirs to do.
 *
 * ONE APPLICATION, SEVERAL TYPES. 0.5 from Week-off and 1.5 from Earned Leave is one act
 * here and becomes two `leave_requests` sharing an `application_group_id` (migration 039700).
 * Each row is still guarded independently per type by the five triggers around
 * `leave_requests`, including the per-type balance check — which is exactly why this shape was
 * chosen over putting the leave type on the day.
 *
 * SICK LEAVE IS EXCLUSIVE AND THE FORM SAYS SO BEFORE SUBMIT. Choosing it clears any other
 * allocation and disables the rest, rather than letting somebody build an application the
 * database will refuse. The database refuses it too — `leave_requests_combination_guard`,
 * verified live: "Sick Leave must be taken on its own and cannot be combined with another
 * leave type". The screen is the courtesy; the trigger is the rule.
 *
 * NOTHING HERE COUNTS DAYS AGAINST A CALENDAR. Which dates are weekly offs or holidays is
 * `calc_leave_days`' answer, and a browser copy would disagree the first time a rota changed.
 * The employee states a number; the server decides which dates it lands on and the request
 * carries its own `total_days`.
 *
 * @route /me/leave/apply-combined
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, CheckCircle2, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { mutationUserMessage } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMyLeaveContext } from "../hooks/useLeaveApply";
import { useAllocatableTypes } from "../hooks/useAllocatableTypes";
import {
  allocationProblems,
  canSubmitAllocation,
  remainingDays,
  suggestAllocation,
  type Allocation,
  type AllocationProblem,
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

export default function LeaveApplicationPage() {
  const contextQuery = useMyLeaveContext();
  const context = contextQuery.data ?? null;
  const { types, isPending, error: typesError } = useAllocatableTypes(context);

  const [totalDays, setTotalDays] = useState("1");
  const [fromDate, setFromDate] = useState(nowIstDate());
  const [allocations, setAllocations] = useState<readonly Allocation[]>([]);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [handoverNotes, setHandoverNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<LeaveApplicationResult | null>(null);

  const total = Number.parseFloat(totalDays) || 0;
  const remaining = remainingDays(total, allocations);
  const problems = allocationProblems(total, allocations, types);
  const ready = canSubmitAllocation(total, allocations, types) && reason.trim().length >= 10;

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
    // One member per allocated type. Every member carries the SAME range: the server expands
    // it and stamps each request's own `total_days`, so the split is by type, not by date.
    const members = allocations
      .filter((a) => a.days > 0)
      .map((a) => {
        const type = types.find((candidate) => candidate.id === a.typeId);
        return {
          leaveTypeId: a.typeId,
          leaveTypeName: type?.name ?? "",
          fromDate,
          toDate: fromDate,
          portion: (a.days % 1 === 0.5 ? "first_half" : "full_day") as
            | "full_day"
            | "first_half"
            | "second_half",
        };
      });

    void submitLeaveApplication({
      employeeId: context.id,
      members,
      reason: reason.trim(),
      contactDuringLeave: contact.trim() === "" ? null : contact.trim(),
      handoverToEmployeeId: null,
      handoverNotes: handoverNotes.trim() === "" ? null : handoverNotes.trim(),
    })
      .then((result) => {
        setDone(result);
        setAllocations([]);
        setReason("");
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
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("leave.app.startOn")}</span>
              <input
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                className="h-10 rounded-md border bg-background px-3 text-sm"
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
        </section>

        {/* ── 2. Where the days come from ─────────────────────────────────── */}
        <section className="mt-4 rounded-lg border bg-card p-4">
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
                    </span>
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={chosen === 0 ? "" : String(chosen)}
                    placeholder="0"
                    disabled={locked || empty || busy}
                    onChange={(event) =>
                      setDays(type.id, Number.parseFloat(event.target.value) || 0)
                    }
                    aria-label={t("leave.app.daysFrom", { type: type.name })}
                    className="num h-9 w-20 rounded-md border bg-background px-2 text-right tabular-nums"
                  />
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── 3. Why ──────────────────────────────────────────────────────── */}
        <section className="mt-4 rounded-lg border bg-card p-4">
          <h2 className="font-display text-sm font-semibold">{t("leave.app.step3")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              <span className="font-medium text-muted-foreground">{t("leave.app.reason")}</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
                placeholder={t("leave.app.reasonPlaceholder")}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
              <span className="text-muted-foreground">{t("leave.app.reasonHint")}</span>
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
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">{t("leave.app.handover")}</span>
              <input
                value={handoverNotes}
                onChange={(event) => setHandoverNotes(event.target.value)}
                disabled={busy}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              />
            </label>
          </div>
        </section>

        {/* Everything wrong, all of it, before they press anything. */}
        {problems.length > 0 && total > 0 ? (
          <ul className="mt-4 space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
            {problems.map((problem, i) => (
              <li key={`${problem.kind}-${String(i)}`}>{problemText(problem)}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={!ready || busy} onClick={submit}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {t("leave.app.submit")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("leave.app.submitHint")}</span>
        </div>
      </StateBoundary>
    </div>
  );
}
