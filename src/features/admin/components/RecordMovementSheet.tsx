/**
 * RecordMovementSheet — record a promotion, transfer or reporting change.
 *
 * ── THE GAP THIS CLOSES, AND THE FALSE SENTENCE IT REPLACES ────────────────
 *
 * The Transfers screen carried a notice claiming that "a database trigger writes
 * a lifecycle event whenever a placement field changes". No such trigger exists,
 * and the page's own header said so two screens up: `trg_ele__status_projection`
 * runs the other way (event → employee) and maps all four movement types to NO
 * status change. So editing somebody's department appended nothing, and the
 * movement register stayed empty while the notice told an administrator their
 * change had been recorded.
 *
 * The database has always permitted the write — `ele__admin_insert`, migration
 * 011 — and nothing in the browser performed it. This is the missing act.
 *
 * ── WHY THIS RECORDS THE EVENT AND DOES NOT EDIT THE EMPLOYEE ──────────────
 *
 * Because the two are separate facts and pretending otherwise is what produced
 * the confusion. `employees.department_id` is the CURRENT placement; a movement
 * event is the HISTORY of how it got there. This sheet writes the history, with
 * `from_values` and `to_values` naming what moved, and says plainly that the
 * live record is changed on the employee's own screen.
 *
 * Doing both in one press would need a server function to make it atomic. Until
 * that exists, two explicit acts are honest and one silent half-act is not.
 */
import { useState } from "react";
import { Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { SubmitBlockers, blockerButtonProps, useSubmitAttempt, SubmitAttemptScope } from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { t } from "@/shared/i18n/en";
import { nowIstDate } from "@/lib/datetime";
import { useProfileId } from "@/shared/api/employee-scope";
import { useRecordLifecycleEvent } from "../hooks/usePeopleLifecycle";
import { useRefOptions } from "../hooks/useMasters";
import {
  LIFECYCLE_EVENT_LABELS,
  MOVEMENT_EVENT_TYPES,
  type LifecycleEventType,
} from "../api/lifecycle.api";

const BLOCKER_ID = "record-movement-blockers";

export interface RecordMovementSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The person being moved. Chosen on the register, so this sheet never picks. */
  readonly employee: { readonly id: string; readonly name: string | null } | null;
}

export function RecordMovementSheet({ open, onOpenChange, employee }: RecordMovementSheetProps) {
  const actorProfileId = useProfileId();
  const record = useRecordLifecycleEvent();
  const attempt = useSubmitAttempt();

  const [eventType, setEventType] = useState<LifecycleEventType>("transferred");
  const [effectiveDate, setEffectiveDate] = useState(nowIstDate());
  const [fromWhat, setFromWhat] = useState("");
  const [toWhat, setToWhat] = useState("");

  /*
    Departments only, and only when the sheet is open. The other three movement
    types are described in words rather than picked from a master: a promotion
    names a designation, a reporting change names a person, and offering the
    whole directory in a free-text-shaped field would invite the wrong one.
  */
  const departments = useRefOptions("departments", open && eventType === "transferred");

  const blockers: string[] = [];
  if (employee === null) blockers.push(t("admin.movement.need.employee"));
  if (effectiveDate === "") blockers.push(t("admin.movement.need.date"));
  if (toWhat.trim() === "") blockers.push(t("admin.movement.need.to"));
  if (actorProfileId === null) blockers.push(t("admin.movement.need.profile"));

  function reset() {
    setEventType("transferred");
    setEffectiveDate(nowIstDate());
    setFromWhat("");
    setToWhat("");
    record.reset();
    attempt.reset();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && record.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-display">{t("admin.movement.title")}</SheetTitle>
          <SheetDescription>
            {t("admin.movement.description", { name: employee?.name ?? "" })}
          </SheetDescription>
        </SheetHeader>

        <SubmitAttemptScope attempt={attempt}>
          <div className="mt-6 space-y-4">
            <SelectField
              label={t("admin.movement.field.type")}
              value={eventType}
              onChange={(next) => setEventType(next as LifecycleEventType)}
              options={MOVEMENT_EVENT_TYPES.map((type) => ({
                value: type,
                label: LIFECYCLE_EVENT_LABELS[type] ?? type,
              }))}
              hint={t("admin.movement.field.typeHint")}
              required
            />

            <TextField
              type="date"
              label={t("admin.movement.field.date")}
              value={effectiveDate}
              onChange={setEffectiveDate}
              max={nowIstDate()}
              hint={t("admin.movement.field.dateHint")}
              required
            />

            <TextField
              label={t("admin.movement.field.from")}
              value={fromWhat}
              onChange={setFromWhat}
              hint={t("admin.movement.field.fromHint")}
            />

            {eventType === "transferred" ? (
              <SelectField
                label={t("admin.movement.field.toDepartment")}
                value={toWhat}
                onChange={setToWhat}
                options={(departments.data ?? []).map((d) => ({ value: d.name, label: d.name }))}
                placeholder={t("admin.movement.field.toDepartmentPlaceholder")}
                required
              />
            ) : (
              <TextField
                label={t("admin.movement.field.to")}
                value={toWhat}
                onChange={setToWhat}
                hint={t("admin.movement.field.toHint")}
                required
              />
            )}

            <Notice tone="info">{t("admin.movement.liveRecordNote")}</Notice>

            <SubmitBlockers
              attempt={attempt}
              blockers={blockers}
              id={BLOCKER_ID}
              title={t("admin.movement.blockers")}
            />

            {record.userMessage !== null ? (
              <Notice tone="error">{record.userMessage}</Notice>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={record.isPending}>
                {t("common.cancel")}
              </Button>
              <Button
                {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}
                onClick={() => {
                  if (!attempt.press(blockers) || employee === null || actorProfileId === null) return;
                  record
                    .saveAsync(
                      {
                        employeeId: employee.id,
                        eventType,
                        effectiveDate,
                        recordedBy: actorProfileId,
                        /*
                          Stored as the event's own bag, exactly as typed. Nothing
                          here resolves a name to an id — the register renders
                          these against the org masters, and inventing an id from
                          a typed string is how a movement ends up pointing at the
                          wrong department.
                        */
                        ...(fromWhat.trim() !== "" ? { fromValues: { label: fromWhat.trim() } } : {}),
                        toValues: { label: toWhat.trim() },
                      },
                      t("admin.movement.reason", {
                        name: employee.name ?? "",
                        to: toWhat.trim(),
                      }),
                    )
                    .then(() => {
                      confirmSubmitted(t("admin.movement.done"), {
                        detail: t("admin.movement.doneDetail"),
                      });
                      reset();
                      onOpenChange(false);
                    })
                    .catch(() => undefined);
                }}
              >
                <Workflow className="mr-2 size-4" aria-hidden />
                {record.isPending ? t("admin.movement.saving") : t("admin.movement.cta")}
              </Button>
            </div>
          </div>
        </SubmitAttemptScope>
      </SheetContent>
    </Sheet>
  );
}
