/**
 * FieldEditSheet.tsx — the one editor behind every editable field on /me/profile.
 *
 * Presentational by design: the row owns the mutation, so there is exactly one
 * place that decides what gets sent and what the success sentence says.
 *
 * Four properties are load-bearing:
 *
 *  1. IT SHOWS THE CURRENT VALUE. An employee correcting a mobile number needs to
 *     see the wrong one; a form pre-filled with the old value and no label for it
 *     is how people "fix" a field that was already right.
 *  2. IT SAYS WHICH MECHANISM APPLIES, in the title and the description. "Send to
 *     HR" and "Save" are different promises and the button says which one this is.
 *  3. A REJECTED SAVE NEVER CLEARS THE FORM. The server's own sentence appears
 *     above the buttons and the typed value and reason stay put.
 *  4. IT DOES NOT PRETEND THE VALUE CHANGED. On a change request the success
 *     panel quotes the server-minted reference and repeats that the record still
 *     holds the old value until HR approves.
 *
 * The reason floor is `MIN_REASON_LENGTH` (the database's own 10) for a change
 * request, because that sentence is what the approver reads. For a direct edit
 * the note is optional — the caller substitutes a truthful default so the
 * reason-gated `employees` UPDATE still carries one.
 */
import { useEffect, useId, useState } from "react";
import { CheckCircle2, ShieldCheck, UserCheck } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MIN_REASON_LENGTH, isReasonValid } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import {
  dateBounds,
  fieldOptions,
  fieldSpec,
  type EditableField,
  type FieldValue,
} from "../self-edit";

const CONTROL_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export interface FieldEditSheetProps {
  open: boolean;
  column: EditableField;
  label: string;
  /** The value on the record, already formatted for a person. */
  currentDisplay: string;
  /** The value on the record, as a control string. */
  initialValue: string;
  currentRaw: FieldValue;
  pending: boolean;
  /** Plain-English server rejection; the sheet stays open on it. */
  serverMessage: string | null;
  /**
   * Set once the write succeeded. `reference` is the server-minted
   * `approval_requests.request_number` for a change request, null for a direct
   * edit or when the engine issued none.
   */
  done: { readonly reference: string | null } | null;
  /** Validate-and-normalise; the sheet renders the message it returns. */
  validate: (raw: string) => { readonly ok: true } | { readonly ok: false; readonly message: string };
  onSubmit: (raw: string, reason: string) => void;
  onClose: () => void;
}

export function FieldEditSheet({
  open,
  column,
  label,
  currentDisplay,
  initialValue,
  currentRaw,
  pending,
  serverMessage,
  done,
  validate,
  onSubmit,
  onClose,
}: FieldEditSheetProps) {
  const spec = fieldSpec(column);
  const isDirect = spec.mechanism === "direct";
  const [value, setValue] = useState(initialValue);
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const ids = useId();
  const valueId = `${ids}-value`;
  const reasonId = `${ids}-reason`;
  const helpId = `${ids}-help`;
  const errorId = `${ids}-error`;
  const countId = `${ids}-count`;

  // A freshly opened sheet reads the record again and forgets the last attempt:
  // carrying a previous reason into the next field is how one sentence ends up
  // justifying three unrelated changes.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setReason("");
      setFieldError(null);
      setReasonError(null);
    }
  }, [open, initialValue]);

  const options = fieldOptions(column);
  const bounds = dateBounds(column);
  const trimmedReason = reason.trim();
  const reasonOk = isDirect || isReasonValid(trimmedReason);

  function submit() {
    if (pending) return;
    const outcome = validate(value);
    if (!outcome.ok) {
      setFieldError(outcome.message);
      return;
    }
    setFieldError(null);
    if (!isDirect && !isReasonValid(trimmedReason)) {
      setReasonError(t("me.edit.invalid.reason", { min: MIN_REASON_LENGTH }));
      return;
    }
    setReasonError(null);
    onSubmit(value, trimmedReason);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b p-5 text-left">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full",
                isDirect ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
              )}
              aria-hidden
            >
              {isDirect ? <UserCheck className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <SheetTitle className="font-display text-base leading-tight">
                {isDirect
                  ? t("me.edit.sheet.title.direct", { field: label })
                  : t("me.edit.sheet.title.request", { field: label })}
              </SheetTitle>
              <SheetDescription className="mt-1">
                {isDirect ? t("me.edit.sheet.desc.direct") : t("me.edit.sheet.desc.request")}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {done !== null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
            <div className="flex items-start gap-3 rounded-md border border-success/40 bg-success/10 p-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{t("me.edit.sheet.done.title")}</p>
                <p className="text-sm" role="status">
                  {isDirect
                    ? t("me.edit.sheet.done.direct")
                    : done.reference !== null
                      ? t("me.edit.sheet.done.request", { reference: done.reference })
                      : t("me.edit.sheet.done.requestNoRef")}
                </p>
                {isDirect ? null : (
                  <p className="text-xs text-muted-foreground">{t("me.edit.note.noEdit")}</p>
                )}
              </div>
            </div>
            <div className="mt-auto flex justify-end border-t pt-4">
              <Button onClick={onClose}>{t("me.edit.sheet.close")}</Button>
            </div>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex-1 space-y-5 p-5">
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">{t("me.edit.sheet.current")}</p>
                <p className="mt-0.5 break-words text-sm font-medium">{currentDisplay}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={valueId}>{t("me.edit.sheet.new")}</Label>
                {spec.editor === "select" || spec.editor === "boolean" ? (
                  <select
                    id={valueId}
                    value={value}
                    disabled={pending}
                    aria-invalid={fieldError !== null}
                    aria-describedby={`${helpId}${fieldError !== null ? ` ${errorId}` : ""}`}
                    onChange={(event) => {
                      setValue(event.target.value);
                      setFieldError(null);
                    }}
                    className={cn(CONTROL_CLASS, fieldError !== null && "border-destructive")}
                  >
                    <option value="">{t("me.edit.sheet.choose")}</option>
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : spec.editor === "textarea" ? (
                  <textarea
                    id={valueId}
                    value={value}
                    rows={4}
                    disabled={pending}
                    maxLength={spec.maxLength}
                    aria-invalid={fieldError !== null}
                    aria-describedby={`${helpId}${fieldError !== null ? ` ${errorId}` : ""}`}
                    onChange={(event) => {
                      setValue(event.target.value);
                      setFieldError(null);
                    }}
                    className={cn(
                      "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm",
                      "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
                      "focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
                      fieldError !== null && "border-destructive",
                    )}
                  />
                ) : (
                  <Input
                    id={valueId}
                    type={spec.editor === "date" ? "date" : "text"}
                    value={value}
                    disabled={pending}
                    aria-invalid={fieldError !== null}
                    aria-describedby={`${helpId}${fieldError !== null ? ` ${errorId}` : ""}`}
                    className={cn("h-11", fieldError !== null && "border-destructive")}
                    {...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {})}
                    {...(spec.inputMode !== undefined ? { inputMode: spec.inputMode } : {})}
                    {...(bounds.min !== undefined ? { min: bounds.min } : {})}
                    {...(bounds.max !== undefined ? { max: bounds.max } : {})}
                    onChange={(event) => {
                      setValue(event.target.value);
                      setFieldError(null);
                    }}
                  />
                )}
                <p id={helpId} className="text-xs text-muted-foreground">
                  {spec.helpKey !== undefined
                    ? t(spec.helpKey, { max: spec.maxLength ?? 0 })
                    : isDirect
                      ? t("me.edit.note.selfImmediate")
                      : t("me.edit.note.howItWorks")}
                </p>
                {currentRaw === null && !isDirect ? (
                  <p className="text-xs text-muted-foreground">{t("me.edit.sheet.noClear")}</p>
                ) : null}
                {fieldError !== null ? (
                  <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
                    {fieldError}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={reasonId}>
                  {isDirect ? t("me.edit.sheet.reason.direct") : t("me.edit.sheet.reason.request")}
                </Label>
                <textarea
                  id={reasonId}
                  value={reason}
                  rows={3}
                  disabled={pending}
                  aria-invalid={reasonError !== null}
                  aria-describedby={countId}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReasonError(null);
                  }}
                  className={cn(
                    "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm",
                    "ring-offset-background focus-visible:outline-none focus-visible:ring-2",
                    "focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
                    reasonError !== null && "border-destructive",
                  )}
                />
                <p id={countId} className="text-xs text-muted-foreground" aria-live="polite">
                  {isDirect
                    ? t("me.edit.sheet.reason.directHint")
                    : reasonOk
                      ? t("me.edit.sheet.reason.enough", { count: trimmedReason.length })
                      : t("me.edit.sheet.reason.count", {
                          count: trimmedReason.length,
                          min: MIN_REASON_LENGTH,
                        })}
                </p>
                {isDirect ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t("me.edit.sheet.reason.requestHint")}
                  </p>
                )}
                {reasonError !== null ? (
                  <p className="text-xs font-medium text-destructive" role="alert">
                    {reasonError}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="space-y-3 border-t p-5">
              {serverMessage !== null ? (
                <p className="text-sm font-medium text-destructive" role="alert">
                  {serverMessage}
                </p>
              ) : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                  {t("me.edit.sheet.cancel")}
                </Button>
                <Button type="submit" disabled={pending || !reasonOk}>
                  {pending
                    ? isDirect
                      ? t("me.edit.sheet.submitting.direct")
                      : t("me.edit.sheet.submitting.request")
                    : isDirect
                      ? t("me.edit.sheet.submit.direct")
                      : t("me.edit.sheet.submit.request")}
                </Button>
              </div>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
