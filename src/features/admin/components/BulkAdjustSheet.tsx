/**
 * BulkAdjustSheet — "Adjust all": one leave type, every employee on screen, side by
 * side with what they already hold.
 *
 * WHY THIS SHAPE
 * --------------
 * The alternative considered was a spreadsheet round trip — download, fill, upload.
 * This is better for the job it is actually for, which is granting a day or two of
 * week-off to a handful of people: a downloaded file cannot show the CURRENT balance
 * beside the number being typed, and "31 → 32" is the check that catches a mistake.
 * It also avoids re-importing every encoding problem a CSV brings for what is
 * usually a dozen small edits.
 *
 * THE EMPLOYEES ARE THE ONES ALREADY FILTERED
 * -------------------------------------------
 * Whatever the balances grid is showing is what appears here — Management by
 * default. A sheet listing all 83 when the reader had narrowed to 19 would be a
 * different question from the one they asked.
 *
 * IT SHOWS BEFORE IT WRITES, AND EVERY WRITE IS THE SAME AUDITED RPC
 * ------------------------------------------------------------------
 * Nothing is posted until Apply, and each row goes through `adjust_leave_balance`
 * exactly as the single-adjustment screen does: one ledger entry, a reason, and the
 * balance re-derived server-side. There is no bulk path, deliberately — a bulk write
 * that skipped the RPC would skip its permission check and its recompute too.
 *
 * NOT TRANSACTIONAL, AND SAID SO ON THE SCREEN. Each row is its own audited write,
 * so a failure part way leaves the earlier rows applied. It is safe to re-open and
 * apply again: a row already at its figure produces no change the second time.
 */
import { useMemo, useState } from "react";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDays } from "@/lib/format";
import { nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "./Notice";
import { SelectField, type SelectOption } from "./Field";
import { useLeaveAdjustment, useMonthlyExtraWork } from "../hooks/useAdminLeave";
import { istToday } from "@/lib/datetime";
import {
  referenceMonth,
  suggestWeekOffs,
  type ExtraWork,
} from "../people/weekOffSuggestion";
import type { LeaveType } from "../api/leave.api";
import {
  planBulkAdjust,
  preferredTypeOrder,
  type AdjustDirection,
  type BulkRowInput,
} from "../people/bulkAdjust";

export interface BulkAdjustSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The offered leave types, already filtered to active by the caller. */
  readonly types: readonly LeaveType[];
  /** Exactly the employees the grid is showing, with their current balances. */
  readonly people: readonly {
    readonly employeeId: string;
    readonly employeeCode: string;
    readonly employeeName: string;
    /** Balance per leave type id. */
    readonly byTypeId: ReadonlyMap<string, number>;
  }[];
  /** What the filter says, so the sheet can name who it is about to change. */
  readonly scopeLabel: string;
}

export function BulkAdjustSheet({
  open,
  onOpenChange,
  types,
  people,
  scopeLabel,
}: BulkAdjustSheetProps) {
  const adjust = useLeaveAdjustment();
  const ordered = useMemo(() => preferredTypeOrder(types), [types]);

  /*
    WHICH MONTH THE SUGGESTION READS. Before the 15th, the month that just ended;
    from the 15th, the month you are in. The rule lives in `referenceMonth` with its
    own tests — including the venue's awkward example, 31 August suggesting August
    rather than July.
  */
  const period = useMemo(() => referenceMonth(istToday()), []);
  const extraWork = useMonthlyExtraWork(period.year, period.month);

  const extraByEmployee = useMemo(() => {
    const map = new Map<string, ExtraWork & { daysRecorded: number }>();
    for (const row of extraWork.data ?? []) {
      map.set(row.employee_id, {
        employeeId: row.employee_id,
        extraWorkMinutes: row.extra_work_minutes,
        overtimeMinutes: row.overtime_minutes,
        daysRecorded: row.days_recorded,
      });
    }
    return map;
  }, [extraWork.data]);
  const [typeId, setTypeId] = useState<string>(() => ordered[0]?.id ?? "");
  const [direction, setDirection] = useState<AdjustDirection>("credit");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ done: number; failed: string[] } | null>(null);
  const [running, setRunning] = useState(false);

  const chosenType = types.find((type) => type.id === typeId) ?? null;

  /*
    SUGGESTIONS ARE FOR WEEK-OFF ONLY.

    The arithmetic is "worked a rest day, owed a rest day", which says nothing about
    how much maternity or sick leave somebody should have. Offering a number under
    those columns would be inventing a policy the venue has not stated, so the
    column stays empty and says why.
  */
  const suggestsFor = chosenType?.code === "MRL";

  const rows: BulkRowInput[] = useMemo(
    () =>
      people.map((person) => ({
        employeeId: person.employeeId,
        employeeCode: person.employeeCode,
        employeeName: person.employeeName,
        current: person.byTypeId.get(typeId) ?? 0,
        typed: typed[person.employeeId] ?? "",
      })),
    [people, typeId, typed],
  );

  /** Suggested days per employee, or undefined where the month recorded nothing. */
  const suggestions = useMemo(() => {
    if (!suggestsFor) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const person of people) {
      const extra = extraByEmployee.get(person.employeeId);
      if (extra === undefined) continue;
      map.set(person.employeeId, suggestWeekOffs(extra.extraWorkMinutes));
    }
    return map;
  }, [suggestsFor, people, extraByEmployee]);

  const suggestedTotal = useMemo(
    () => [...suggestions.values()].filter((days) => days > 0).length,
    [suggestions],
  );

  /** Copy every non-zero suggestion into the inputs, leaving the rest blank. */
  function takeAllSuggestions(): void {
    const next: Record<string, string> = {};
    for (const [employeeId, days] of suggestions) {
      if (days > 0) next[employeeId] = String(days);
    }
    setTyped(next);
    setResult(null);
  }

  const plan = useMemo(
    () => planBulkAdjust(rows, direction, chosenType?.max_balance_days ?? null),
    [rows, direction, chosenType],
  );

  function reset(): void {
    setTyped({});
    setResult(null);
  }

  async function apply(): Promise<void> {
    if (plan.changes.length === 0 || plan.problems.length > 0) return;
    setRunning(true);
    const failed: string[] = [];
    let done = 0;
    const today = nowIstDate();
    const typeName = chosenType?.name ?? "";

    for (const change of plan.changes) {
      try {
        await adjust.mutateAsync({
          input: {
            employeeId: change.employeeId,
            leaveTypeId: typeId,
            /* The RPC takes a POSITIVE count plus a direction and negates a debit
               itself. Passing a negative count with kind 'debit' would double the
               sign and credit the employee. */
            days: Math.abs(change.delta),
            kind: change.delta > 0 ? "credit" : "debit",
            effectiveDate: today,
            reasonCategory: "bulk_adjustment",
          },
          reason: `Bulk ${typeName} adjustment for ${scopeLabel}: ${change.employeeCode} from ${formatDays(change.current)} to ${formatDays(change.target)}`,
        });
        done += 1;
      } catch (error) {
        failed.push(
          `${change.employeeCode}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    setRunning(false);
    setResult({ done, failed });
    /* The typed figures are cleared on success so a second Apply cannot repeat the
       work by accident; the balances behind the sheet refresh from the mutation's
       own invalidation. */
    if (failed.length === 0) setTyped({});
  }

  const typeChoices: SelectOption[] = ordered.map((type) => ({
    value: type.id,
    label: type.name,
  }));

  const directionChoices: SelectOption[] = [
    { value: "credit", label: t("admin.leaveBal.bulk.credit") },
    { value: "debit", label: t("admin.leaveBal.bulk.debit") },
    { value: "set", label: t("admin.leaveBal.bulk.set") },
  ];

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-display">{t("admin.leaveBal.bulk.title")}</SheetTitle>
          <SheetDescription>
            {t("admin.leaveBal.bulk.description", {
              scope: scopeLabel,
              count: String(people.length),
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField
            label={t("admin.leaveBal.bulk.type")}
            value={typeId}
            options={typeChoices}
            onChange={(value) => {
              setTypeId(value);
              /* Figures typed against one type must not carry to another: "1" meant
                 as a week-off day is not 1 day of earned leave. */
              setTyped({});
              setResult(null);
            }}
          />
          <SelectField
            label={t("admin.leaveBal.bulk.direction")}
            value={direction}
            options={directionChoices}
            onChange={(value) => {
              setDirection(value as AdjustDirection);
              setResult(null);
            }}
          />
        </div>

        <Notice tone="note" className="mt-4">
          {direction === "set"
            ? t("admin.leaveBal.bulk.hint.set")
            : t("admin.leaveBal.bulk.hint.move")}
        </Notice>

        {suggestsFor ? (
          <Notice tone="info" className="mt-3">
            <p>
              {t("admin.leaveBal.bulk.suggest.basis", {
                month: period.label,
                which: period.isCurrentMonth
                  ? t("admin.leaveBal.bulk.suggest.thisMonth")
                  : t("admin.leaveBal.bulk.suggest.lastMonth"),
              })}
            </p>
            <p className="mt-1">{t("admin.leaveBal.bulk.suggest.onlyASuggestion")}</p>
            {suggestedTotal > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={running}
                onClick={() => takeAllSuggestions()}
              >
                {t("admin.leaveBal.bulk.suggest.useAll", { count: String(suggestedTotal) })}
              </Button>
            ) : (
              <p className="mt-1 text-muted-foreground">
                {extraWork.isLoading
                  ? t("admin.leaveBal.bulk.suggest.loading")
                  : t("admin.leaveBal.bulk.suggest.none", { month: period.label })}
              </p>
            )}
          </Notice>
        ) : null}

        {plan.problems.length > 0 ? (
          <Notice tone="error" className="mt-4">
            <ul className="space-y-1">
              {plan.problems.map((problem) => (
                <li key={`${problem.employeeCode}:${problem.message}`}>
                  <span className="num">{problem.employeeCode}</span> — {problem.message}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {result !== null ? (
          <Notice tone={result.failed.length === 0 ? "success" : "warning"} className="mt-4">
            <p className="font-medium">
              {t("admin.leaveBal.bulk.applied", { count: String(result.done) })}
            </p>
            {result.failed.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {result.failed.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}

        <div className="mt-4 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">{t("admin.leaveBal.col.employee")}</th>
                <th className="px-3 py-2 text-right">{t("admin.leaveBal.bulk.now")}</th>
                {suggestsFor ? (
                  <th className="px-3 py-2 text-right">
                    {t("admin.leaveBal.bulk.suggest.col")}
                  </th>
                ) : null}
                <th className="px-3 py-2 text-right">
                  {direction === "set"
                    ? t("admin.leaveBal.bulk.setTo")
                    : t("admin.leaveBal.bulk.days")}
                </th>
                <th className="px-3 py-2 text-right">{t("admin.leaveBal.bulk.after")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const change = plan.changes.find((c) => c.employeeId === row.employeeId);
                const problem = plan.problems.find((p) => p.employeeCode === row.employeeCode);
                return (
                  <tr key={row.employeeId} className="border-t">
                    <td className="px-3 py-2">
                      <span className="block leading-tight">{row.employeeName}</span>
                      <span className="num text-xs text-muted-foreground">
                        {row.employeeCode}
                      </span>
                    </td>
                    <td className="num px-3 py-2 text-right text-muted-foreground">
                      {formatDays(row.current)}
                    </td>
                    {suggestsFor ? (
                      <td className="px-3 py-2 text-right">
                        {(() => {
                          const suggested = suggestions.get(row.employeeId);
                          if (suggested === undefined) {
                            /* No attendance row for the month at all — different
                               from "nothing extra worked", and said differently. */
                            return (
                              <span
                                className="text-xs text-muted-foreground"
                                title={t("admin.leaveBal.bulk.suggest.noData")}
                              >
                                —
                              </span>
                            );
                          }
                          if (suggested === 0) {
                            return <span className="num text-muted-foreground">0</span>;
                          }
                          const extra = extraByEmployee.get(row.employeeId);
                          return (
                            <button
                              type="button"
                              disabled={running}
                              onClick={() => {
                                setTyped((current) => ({
                                  ...current,
                                  [row.employeeId]: String(suggested),
                                }));
                                setResult(null);
                              }}
                              title={t("admin.leaveBal.bulk.suggest.cellTitle", {
                                extra: String(Math.round((extra?.extraWorkMinutes ?? 0) / 6) / 10),
                                ot: String(Math.round((extra?.overtimeMinutes ?? 0) / 6) / 10),
                              })}
                              className="num rounded-md px-2 py-0.5 text-primary underline decoration-dotted hover:bg-primary/10"
                            >
                              {formatDays(suggested)}
                            </button>
                          );
                        })()}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right">
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={t("admin.leaveBal.bulk.inputAria", {
                          name: row.employeeName,
                        })}
                        value={row.typed}
                        onChange={(event) => {
                          setTyped((current) => ({
                            ...current,
                            [row.employeeId]: event.target.value,
                          }));
                          setResult(null);
                        }}
                        className={`num w-20 rounded-md border bg-background px-2 py-1 text-right ${
                          problem !== undefined ? "border-destructive" : ""
                        }`}
                      />
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {/* Blank until something is typed: showing the current figure
                          here would read as a change that is not being made. */}
                      {change === undefined ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="font-semibold">{formatDays(change.target)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("admin.leaveBal.bulk.summary", {
              changes: String(plan.changes.length),
              skipped: String(plan.skipped),
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={running} onClick={() => reset()}>
              {t("admin.leaveBal.bulk.clear")}
            </Button>
            <Button
              size="sm"
              disabled={running || plan.changes.length === 0 || plan.problems.length > 0}
              onClick={() => {
                void apply();
              }}
            >
              <Layers className="h-4 w-4" aria-hidden />
              {running
                ? t("admin.leaveBal.bulk.applying")
                : t("admin.leaveBal.bulk.apply", { count: String(plan.changes.length) })}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
