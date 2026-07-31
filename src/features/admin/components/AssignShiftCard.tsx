/**
 * AssignShiftCard — put ONE employee on a different shift, from a date.
 *
 * WHY IT LIVES ON THE RESOLVER. This screen already shows which of the five precedence
 * steps answered for this person on this date, so it is the one place an administrator
 * can see what they are about to override BEFORE they override it. Offering the same
 * control on a list screen would mean changing somebody's hours without being shown
 * whether a published roster slot is going to win anyway.
 *
 * WHAT IT OVERRIDES, AND WHAT STILL BEATS IT. Precedence is roster slot →
 * **shift_assignments** → `employees.shift_id` → `designations.default_shift_id` → the
 * company's 'G' shift. So this beats the employee's own default and the designation's,
 * and it does NOT beat a published roster slot — correct, because a slot is a decision
 * about one named day and this is a standing arrangement. The card says so rather than
 * letting an admin discover it from a shift that did not change.
 *
 * WHY THE TABLE WAS EMPTY BEFORE THIS. `shift_assignments` has existed since migration
 * 014, `resolve_shift_for_date` has read it as step 2 all along, and this screen already
 * DISPLAYED it — but nothing in the product could write a row. Changing one person's
 * hours meant editing their designation's default, which moves everybody on that
 * designation, or the shift master itself, which moves the whole venue. That is the gap.
 *
 * NO END DATE IS THE COMMON CASE. "From Monday, Asha works the evening shift" has no end.
 * `ex_shift_assignments__no_overlap` refuses a second overlapping row, so this does not
 * silently close the previous assignment — ending one is a separate, deliberate act with
 * its own reason, and a constraint violation is a better outcome than two live answers.
 */
import { useState } from "react";
import { CalendarCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { fmtCivilDate, fmtDurationHm, istToday } from "@/lib/datetime";
import { paidDurationMinutes, shiftWindowProblem } from "../shiftTiming";
import { deriveCode } from "../people/orgOther";
import { t } from "@/shared/i18n/en";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import { useShiftAssign, useShiftCreateAndAssign } from "../hooks/useTimePolicy";
import type { ShiftAssignment } from "../api/time-policy.api";

export interface AssignShiftCardProps {
  readonly employeeId: string;
  readonly employeeName: string;
  /** The shift the resolver says is in force today, for the "currently" line. */
  readonly currentShiftLabel: string | null;
  /** True when a published roster slot answered — this override will not win today. */
  readonly rosterSlotWins: boolean;
}

export function AssignShiftCard({
  employeeId,
  employeeName,
  currentShiftLabel,
  rosterSlotWins,
}: AssignShiftCardProps) {
  const shifts = useRefOptions("shifts");
  const companyId = useDefaultCompanyId();
  /*
    TWO MODES, because `shift_assignments` carries `shift_id` and no times of its own.
    "This employee works 10:00–19:00" is therefore not directly expressible — the timings
    have to exist as a shift first. Rather than send the admin off to Time · Shifts to
    invent a code and come back, `new` creates the shift and assigns it in one act. Same
    reasoning as the "Other" option on the org lookups.
  */
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [newName, setNewName] = useState("");
  const [newStart, setNewStart] = useState("09:30");
  const [newEnd, setNewEnd] = useState("18:30");
  const [newBreak, setNewBreak] = useState("60");
  const [newGraceIn, setNewGraceIn] = useState("5");
  const [newGraceOut, setNewGraceOut] = useState("10");
  const [shiftId, setShiftId] = useState("");
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [done, setDone] = useState<ShiftAssignment | null>(null);

  const assign = useShiftAssign((row) => {
    setDone(row);
    setReasonOpen(false);
    setShiftId("");
    setTo("");
  });

  const createAndAssign = useShiftCreateAndAssign((result) => {
    setDone(result.assignment);
    setReasonOpen(false);
    setNewName("");
    setTo("");
    setMode("existing");
  });

  const breakMinutes = Number.parseInt(newBreak, 10) || 0;
  const windowProblem = shiftWindowProblem(newStart, newEnd, breakMinutes);
  const paidMinutes = paidDurationMinutes(newStart, newEnd, breakMinutes);
  const derivedCode = deriveCode(newName);
  const busy = assign.isPending || createAndAssign.isPending;

  const options = (shifts.data ?? []).map((row) => ({ value: row.id, label: row.name }));
  const ready =
    from !== "" &&
    (mode === "existing"
      ? shiftId !== ""
      : newName.trim() !== "" && derivedCode !== "" && windowProblem === null && companyId !== null);

  return (
    <section className="mb-6 rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
        <CalendarCog className="size-4 text-primary" aria-hidden />
        {t("timeAudit.assignShift.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {currentShiftLabel === null
          ? t("timeAudit.assignShift.hintNoCurrent", { name: employeeName })
          : t("timeAudit.assignShift.hint", {
              name: employeeName,
              shift: currentShiftLabel,
            })}
      </p>

      {/* Said BEFORE the form, not after the save: an override that loses to a roster
          slot is not a failure, it is a precedence an admin has to know about. */}
      {rosterSlotWins ? (
        <div className="mt-3">
          <Notice tone="warning">{t("timeAudit.assignShift.rosterWins")}</Notice>
        </div>
      ) : null}

      {/* Pick an existing shift, or describe the timings and let this make one. */}
      <div className="mt-3 flex flex-wrap gap-1" role="group" aria-label={t("timeAudit.assignShift.modeAria")}>
        {(["existing", "new"] as const).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={mode === key ? "default" : "outline"}
            aria-pressed={mode === key}
            disabled={busy}
            onClick={() => setMode(key)}
          >
            {key === "existing"
              ? t("timeAudit.assignShift.mode.existing")
              : t("timeAudit.assignShift.mode.new")}
          </Button>
        ))}
      </div>

      {mode === "new" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            label={t("timeAudit.assignShift.newName")}
            value={newName}
            onChange={setNewName}
            required
            disabled={busy}
            hint={
              derivedCode === ""
                ? t("timeAudit.assignShift.newNameHint")
                : t("timeAudit.assignShift.newCode", { code: derivedCode })
            }
            placeholder={t("timeAudit.assignShift.newNamePlaceholder")}
          />
          <TextField
            label={t("timeAudit.assignShift.start")}
            value={newStart}
            onChange={setNewStart}
            type="time"
            required
            disabled={busy}
          />
          <TextField
            label={t("timeAudit.assignShift.end")}
            value={newEnd}
            onChange={setNewEnd}
            type="time"
            required
            disabled={busy}
            hint={t("timeAudit.assignShift.endHint")}
          />
          <TextField
            label={t("timeAudit.assignShift.break")}
            value={newBreak}
            onChange={setNewBreak}
            type="number"
            min="0"
            disabled={busy}
          />
          <TextField
            label={t("timeAudit.assignShift.graceIn")}
            value={newGraceIn}
            onChange={setNewGraceIn}
            type="number"
            min="0"
            max="240"
            disabled={busy}
            hint={t("timeAudit.assignShift.graceInHint")}
          />
          <TextField
            label={t("timeAudit.assignShift.graceOut")}
            value={newGraceOut}
            onChange={setNewGraceOut}
            type="number"
            min="0"
            max="240"
            disabled={busy}
          />
        </div>
      ) : null}

      {/* The paid length, computed the way `shifts_before_write()` does — shown because it
          is a NOT NULL column derived from three of the boxes above, and an admin should
          see it before saving rather than discover it in the shift list. */}
      {mode === "new" && windowProblem === null && paidMinutes !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("timeAudit.assignShift.paid", { hours: fmtDurationHm(paidMinutes) })}
        </p>
      ) : null}
      {mode === "new" && windowProblem !== null && newName.trim() !== "" ? (
        <p className="mt-2 text-xs font-medium text-destructive" role="alert">
          {windowProblem === "unparseable"
            ? t("timeAudit.assignShift.badWindow")
            : t("timeAudit.assignShift.breakTooLong")}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {mode === "existing" ? (
          <SelectField
            label={t("timeAudit.assignShift.shift")}
            value={shiftId}
            options={options}
            onChange={setShiftId}
            placeholder="—"
            required
            disabled={busy}
            hint={t("timeAudit.assignShift.shiftHint")}
          />
        ) : null}
        <TextField
          label={t("timeAudit.assignShift.from")}
          value={from}
          onChange={setFrom}
          type="date"
          required
          disabled={busy}
          hint={t("timeAudit.assignShift.fromHint")}
        />
        <TextField
          label={t("timeAudit.assignShift.to")}
          value={to}
          onChange={setTo}
          type="date"
          disabled={busy}
          hint={t("timeAudit.assignShift.toHint")}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={!ready || busy}
          onClick={() => setReasonOpen(true)}
        >
          {t("timeAudit.assignShift.action")}
        </Button>
        {done !== null ? (
          <p className="text-xs text-success">
            {t("timeAudit.assignShift.done", { from: fmtCivilDate(done.effective_from) })}
          </p>
        ) : null}
      </div>

      <ReasonDialog
        open={reasonOpen}
        title={t("timeAudit.assignShift.reasonTitle")}
        description={t("timeAudit.assignShift.reasonBody", { name: employeeName })}
        minLength={SENSITIVE_REASON_LENGTH}
        pending={busy}
        errorMessage={assign.userMessage ?? createAndAssign.userMessage ?? null}
        onCancel={() => setReasonOpen(false)}
        onConfirm={(reason) => {
          if (mode === "existing") {
            assign.save(
              {
                employeeId,
                shiftId,
                effectiveFrom: from,
                ...(to === "" ? {} : { effectiveTo: to }),
              },
              reason,
            );
            return;
          }
          // `ready` already refused a null company and an impossible window.
          if (companyId === null || paidMinutes === null) return;
          createAndAssign.save(
            {
              companyId,
              employeeId,
              name: newName.trim(),
              code: derivedCode,
              startTime: newStart,
              endTime: newEnd,
              durationMinutes: paidMinutes,
              unpaidBreakMinutes: breakMinutes,
              graceInMinutes: Number.parseInt(newGraceIn, 10) || 0,
              graceOutMinutes: Number.parseInt(newGraceOut, 10) || 0,
              effectiveFrom: from,
              ...(to === "" ? {} : { effectiveTo: to }),
            },
            reason,
          );
        }}
      />
    </section>
  );
}
