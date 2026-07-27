/**
 * ReasonDialog — the prompt that collects the audit reason before a sensitive
 * save (spec-admin D-21, §3.5 "Reason required: DOJ, status, compensation,
 * bank, statutory-ID, any locked/paid-period change").
 *
 * Three properties are load-bearing:
 *
 *  1. It ASKS. The UI never invents a reason for a salary, bank, role or lock
 *     change. A default sentence is acceptable for routine field edits, and
 *     those edits do not open this dialog at all.
 *  2. It says out loud that the sentence is recorded against the admin's own
 *     name and is readable by the employee and by an auditor. People write
 *     better reasons when they know that.
 *  3. It CANNOT be dismissed silently. There is no close button, no overlay
 *     click-through, and no Escape-to-vanish once something has been typed —
 *     the only ways out are Save (writes) and Cancel (explicitly discards).
 *     Escape on an untouched dialog is honoured, because trapping the keyboard
 *     on an empty form is hostile, not safe.
 *
 * Built directly on @radix-ui/react-alert-dialog: an alertdialog is
 * modal-by-default, refuses outside-pointer dismissal, and moves focus into the
 * textarea. There is no `components/ui/alert-dialog.tsx` in this repo yet and
 * this is the only consumer, so the primitive stays local rather than forking a
 * shadcn atom.
 */
import { useEffect, useId, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MIN_REASON_LENGTH } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";

export interface ReasonDialogProps {
  open: boolean;
  /** What is being changed, in the imperative: "Change Suresh Gowda's salary". */
  title?: string;
  /**
   * One line naming the exact change, ideally with the old and new value. This
   * is the diff preview spec-admin §3.5 asks for on a sensitive touch.
   */
  description?: string;
  /** The signed-in admin's display name — shown in the attribution line. */
  actorName?: string | null;
  /** Minimum characters. Defaults to the database floor (10); D-21 wants 15. */
  minLength?: number;
  /** Label of the confirm button when the default is too vague. */
  confirmLabel?: string;
  /** True while the write is in flight: the dialog locks instead of closing. */
  pending?: boolean;
  /**
   * A server rejection to surface INSIDE the dialog, already in plain English
   * (`useAuditedMutation().userMessage`). The dialog stays open so the admin can
   * edit the reason instead of retyping the whole change.
   */
  errorMessage?: string | null;
  /** Called with the trimmed reason. The caller performs the write. */
  onConfirm: (reason: string) => void;
  /** Called when the admin explicitly abandons the change. */
  onCancel: () => void;
}

export function ReasonDialog({
  open,
  title,
  description,
  actorName,
  minLength,
  confirmLabel,
  pending = false,
  errorMessage,
  onConfirm,
  onCancel,
}: ReasonDialogProps) {
  const min = minLength ?? MIN_REASON_LENGTH;
  const [reason, setReason] = useState("");
  const [showTooShort, setShowTooShort] = useState(false);
  const [showCancelHint, setShowCancelHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const countId = `${fieldId}-count`;
  const errorId = `${fieldId}-error`;

  // A fresh dialog gets a fresh reason: carrying the previous justification into
  // the next change is how one sentence ends up on five unrelated audit rows.
  useEffect(() => {
    if (open) {
      setReason("");
      setShowTooShort(false);
      setShowCancelHint(false);
    }
  }, [open]);

  const trimmed = reason.trim();
  const count = trimmed.length;
  const isLongEnough = count >= min;

  function confirm() {
    if (pending) return;
    if (!isLongEnough) {
      setShowTooShort(true);
      textareaRef.current?.focus();
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4",
            "rounded-lg border bg-background p-5 shadow-lg sm:p-6",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
          onEscapeKeyDown={(event) => {
            // Silent dismissal is the thing this dialog exists to prevent.
            if (pending || reason !== "") {
              event.preventDefault();
              setShowCancelHint(true);
              return;
            }
            onCancel();
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning/10 text-warning"
              aria-hidden
            >
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <AlertDialog.Title className="font-display text-base font-semibold leading-tight">
                {title ?? t("reason.dialog.title")}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
                {description ?? t("reason.dialog.hint")}
              </AlertDialog.Description>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t("reason.dialog.label")}
            </label>
            <textarea
              id={fieldId}
              ref={textareaRef}
              value={reason}
              rows={3}
              autoFocus
              disabled={pending}
              onChange={(event) => {
                setReason(event.target.value);
                setShowTooShort(false);
                setShowCancelHint(false);
              }}
              onKeyDown={(event) => {
                // ⌘/Ctrl+Enter saves; a bare Enter stays a newline so a reason
                // can be more than one line.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  confirm();
                }
              }}
              placeholder={t("reason.dialog.placeholder")}
              aria-describedby={`${hintId} ${countId}${errorMessage ? ` ${errorId}` : ""}`}
              aria-invalid={showTooShort || Boolean(errorMessage)}
              className={cn(
                "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
                (showTooShort || Boolean(errorMessage)) && "border-destructive",
              )}
            />
            <p id={countId} className="text-xs text-muted-foreground" aria-live="polite">
              {isLongEnough
                ? t("reason.dialog.enough", { count })
                : t("reason.dialog.minLength", { min, count })}
            </p>
            <p id={hintId} className="text-xs text-muted-foreground">
              {t("reason.dialog.hint")}
              {actorName ? ` ${t("reason.dialog.attribution", { name: actorName })}` : ""}
            </p>
            {showTooShort ? (
              <p className="text-xs font-medium text-destructive" role="alert">
                {t("reason.dialog.tooShort")}
              </p>
            ) : null}
            {errorMessage ? (
              <p id={errorId} className="text-sm font-medium text-destructive" role="alert">
                {errorMessage}
              </p>
            ) : null}
            {showCancelHint ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t("reason.dialog.cancelHint")}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              {t("reason.dialog.cancel")}
            </Button>
            <Button onClick={confirm} disabled={pending || !isLongEnough}>
              {pending ? t("reason.dialog.pending") : confirmLabel ?? t("reason.dialog.confirm")}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
