/**
 * OffHoursPunchDialog — the justification an off-hours punch needs, asked as a question.
 *
 * ── WHAT THIS REPLACED, AND WHY ──────────────────────────────────────────────
 * The reason box and the proof picker used to sit INLINE under the punch button, and the
 * button stayed disabled until both were satisfied. Three things were wrong with that, and
 * they compound:
 *
 *   · The button — the one thing on the card that looks like the way forward — was dead on
 *     arrival, with the explanation of why below the fold. A dead control teaches people
 *     the app is broken, not that they have something to fill in.
 *   · The form appeared under it, so the employee had to scroll a card they had already
 *     scrolled to, on a phone, standing outside a client's office.
 *   · Nothing said what was being asked until they found it.
 *
 * So the button is always live now, and pressing it ASKS: a modal that names the problem in
 * its title, takes the two things, and then offers the punch as its own confirming action.
 * The employee always has one obvious next thing to press, and it is never disabled before
 * they have been told why.
 *
 * ── WHY THE PUNCH BUTTON LIVES IN HERE ───────────────────────────────────────
 * "After they fill it up, a punch in button should come again, then they can punch in."
 * The confirm is inside the dialog rather than back on the card, so the sequence never
 * hands control back to a surface the employee has to go looking at again. Cancel is
 * offered because somebody who opened this by accident, or thinks better of punching, must
 * be able to leave — this is not a form the app may trap them in.
 *
 * ── NO SCROLL ────────────────────────────────────────────────────────────────
 * The content is sized to fit a phone without scrolling: two compact fields and a footer.
 * `max-h` with `overflow-y-auto` is kept as a floor for a 4-inch screen in landscape with a
 * validation message showing — not as the ordinary path.
 */
import { useId } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, Clock, Loader2, Paperclip, ScanFace, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";

export interface OffHoursPunchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Minimum characters the server and the CHECK constraint both require. */
  readonly minReason: number;
  readonly reason: string;
  readonly onReasonChange: (value: string) => void;
  /** Set once the bytes are in the vault; null until then. */
  readonly proofDocId: string | null;
  readonly proofName: string | null;
  readonly proofBusy: boolean;
  readonly proofError: string | null;
  readonly onPickProof: (file: File) => void;
  /** True while a capture is already running, so the confirm cannot be pressed twice. */
  readonly busy: boolean;
  /** Starts the face capture. The dialog closes itself first. */
  readonly onConfirm: () => void;
  /** What the punch will be recorded as — an arrival or a departure. */
  readonly directionLabel: string | null;
}

export function OffHoursPunchDialog({
  open,
  onOpenChange,
  minReason,
  reason,
  onReasonChange,
  proofDocId,
  proofName,
  proofBusy,
  proofError,
  onPickProof,
  busy,
  onConfirm,
  directionLabel,
}: OffHoursPunchDialogProps): React.JSX.Element {
  const reasonId = useId();
  const proofId = useId();

  const reasonOk = reason.trim().length >= minReason;
  /*
    An upload that FAILED does not block the punch.

    The server records a proofless off-hours punch and flags it for an administrator to
    chase, which is the right outcome: a photograph that would not upload is not evidence
    of anything, and refusing the punch over it once left somebody unable to log in at all
    at 8 am. So `proofError` satisfies this gate exactly as an attachment does — the
    difference is recorded, not enforced here.
  */
  const proofSettled = proofDocId !== null || proofError !== null;
  const canPunch = reasonOk && proofSettled && !proofBusy && !busy;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bark/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border bg-card p-5 shadow-lg",
            // A floor for a very small screen, not the ordinary path — see the header note.
            "max-h-[calc(100vh-2rem)] overflow-y-auto",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/15">
              <Clock className="size-5 text-warning" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="font-display text-base font-semibold">
                {t("me.punch.offHours.dialog.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {t("me.punch.offHours.dialog.body")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t("me.punch.offHours.dialog.close")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          {/* ── 1. Why ───────────────────────────────────────────────────── */}
          <div className="mt-4">
            <label htmlFor={reasonId} className="block text-sm font-medium">
              {t("me.punch.offHours.dialog.reasonLabel")}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              rows={3}
              maxLength={500}
              autoFocus
              placeholder={t("me.punch.offHours.placeholder")}
              className="mt-1.5 w-full rounded-md border bg-background px-2.5 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {/* Live, not a message after the fact: the requirement is a length, so show it. */}
            <p
              className={cn(
                "mt-1 text-xs tabular-nums",
                reasonOk ? "text-success" : "text-muted-foreground",
              )}
            >
              {t("me.punch.offHours.counter", {
                n: String(reason.trim().length),
                min: String(minReason),
              })}
            </p>
          </div>

          {/* ── 2. Proof ─────────────────────────────────────────────────── */}
          <div className="mt-3 border-t pt-3">
            <label htmlFor={proofId} className="block text-sm font-medium">
              {t("me.punch.offHours.proof.label")}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("me.punch.offHours.proof.hint")}
            </p>
            {/*
              `capture="environment"` opens the rear camera immediately on a phone — which is
              what somebody standing outside a client's office wants — and is an ordinary file
              picker on a laptop, so a screenshot of the meeting invitation works too.

              Uploaded on choose rather than on submit: the employee learns straight away
              whether the vault took it, instead of losing it after a face capture.
            */}
            <input
              id={proofId}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              disabled={proofBusy || busy}
              className="mt-2 w-full text-xs file:mr-2 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1.5 file:text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                // Cleared so choosing the SAME file again re-fires and retries an upload.
                event.target.value = "";
                if (file !== null) onPickProof(file);
              }}
            />
            {proofBusy ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t("me.punch.offHours.proof.uploading")}
              </p>
            ) : proofDocId !== null ? (
              <p className="mt-1.5 flex items-start gap-1.5 break-words text-xs text-success">
                <Paperclip className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("me.punch.offHours.proof.attached", { name: proofName ?? "" })}
              </p>
            ) : null}
            {proofError !== null ? (
              <p className="mt-1.5 text-xs text-destructive">{proofError}</p>
            ) : null}
          </div>

          {/* ── 3. Punch ─────────────────────────────────────────────────── */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button type="button" size="lg" disabled={!canPunch} onClick={onConfirm}>
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : (
                <ScanFace className="mr-2 size-4" aria-hidden />
              )}
              {t("me.punch.offHours.dialog.confirm")}
            </Button>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="sm">
                {t("me.punch.action.cancel")}
              </Button>
            </Dialog.Close>
          </div>

          {/*
            Why the confirm is not yet pressable, said in words. A disabled button with no
            explanation is the thing this whole dialog exists to stop.
          */}
          {!canPunch ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {proofBusy
                ? t("me.punch.offHours.dialog.waitUpload")
                : !reasonOk
                  ? t("me.punch.offHours.dialog.needReason", { min: String(minReason) })
                  : t("me.punch.offHours.dialog.needProof")}
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="size-3.5" aria-hidden />
              {directionLabel ?? t("me.punch.offHours.dialog.ready")}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
