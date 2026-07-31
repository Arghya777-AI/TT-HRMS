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
import { fmtCivilDate, istToday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { useRefOptions } from "../hooks/useMasters";
import { useShiftAssign } from "../hooks/useTimePolicy";
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

  const options = (shifts.data ?? []).map((row) => ({ value: row.id, label: row.name }));
  const ready = shiftId !== "" && from !== "";

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

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <SelectField
          label={t("timeAudit.assignShift.shift")}
          value={shiftId}
          options={options}
          onChange={setShiftId}
          placeholder="—"
          required
          disabled={assign.isPending}
          hint={t("timeAudit.assignShift.shiftHint")}
        />
        <TextField
          label={t("timeAudit.assignShift.from")}
          value={from}
          onChange={setFrom}
          type="date"
          required
          disabled={assign.isPending}
          hint={t("timeAudit.assignShift.fromHint")}
        />
        <TextField
          label={t("timeAudit.assignShift.to")}
          value={to}
          onChange={setTo}
          type="date"
          disabled={assign.isPending}
          hint={t("timeAudit.assignShift.toHint")}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={!ready || assign.isPending}
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
        pending={assign.isPending}
        errorMessage={assign.userMessage ?? null}
        onCancel={() => setReasonOpen(false)}
        onConfirm={(reason) =>
          assign.save(
            {
              employeeId,
              shiftId,
              effectiveFrom: from,
              ...(to === "" ? {} : { effectiveTo: to }),
            },
            reason,
          )
        }
      />
    </section>
  );
}
