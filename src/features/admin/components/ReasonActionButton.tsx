/**
 * ReasonActionButton — an admin action that records WHY it happened.
 *
 * WHAT CHANGED, AND WHY
 * ---------------------
 * Every action here used to open `ReasonDialog` and demand ten or more typed
 * characters before it would fire. The client's verdict, after a day of using it:
 *
 *   "Every time it asks for a comment to be written while pairing, while adding
 *    devices, and everything — you need to remove that."
 *
 * They are right, and the reason is not just friction. A field that blocks the work
 * gets fed whatever clears it: "asdf", "test", "ok". An audit trail full of "asdf"
 * is worse than no free-text field at all, because it looks like provenance and
 * carries none.
 *
 * THE REASON IS STILL RECORDED — it is just no longer typed. `audit.reason_required_tables`
 * enforces `app.reason` on every write to these tables with a DATABASE TRIGGER, so
 * simply deleting the dialog would have made the writes FAIL, not the prompts
 * disappear. Instead the reason is composed from the action itself: the `title` prop
 * already names the exact operation and its subject ("Issue a pairing code for
 * TT-GATE-01"), which is more truthful than anything a rushed admin types at a gate.
 * Who did it, when, from which IP, and the before/after values were never in that
 * box anyway — the audit engine has always captured those.
 *
 * WHAT STILL ASKS: pass `requireTypedReason` for an action where the WORDS matter
 * because a human will later need to know the circumstance rather than the
 * operation — a disciplinary void, an out-of-policy override, an irreversible
 * erasure. Those are rare, and being rare is what makes the typed reason worth
 * reading when it appears.
 *
 * The dialog, when it does open, stays OPEN on failure with the server's sentence
 * inside it, so the admin edits the reason instead of retyping the whole change
 * (`ReasonDialog.errorMessage` exists for exactly this).
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { mutationUserMessage } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";

type ButtonVariant = "default" | "outline" | "ghost" | "destructive" | "secondary" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ReasonActionButtonProps {
  /** Button face. */
  label: ReactNode;
  /** Dialog heading, in the imperative. */
  title: string;
  /** One line naming the exact change, with the old and new value where there is one. */
  description: string;
  confirmLabel?: string | undefined;
  /** D-21 actions raise the floor above the database's 10 characters. */
  minLength?: number | undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** Tooltip/aria hint when disabled — say WHY, never just grey it out. */
  disabledHint?: string | undefined;
  /**
   * Ask the admin to TYPE a reason before this fires.
   *
   * Off by default: the reason is derived from `title`, which already names the
   * operation and its subject. Turn it on only where the CIRCUMSTANCE matters and
   * cannot be inferred from the action — a disciplinary void, an out-of-policy
   * override, an irreversible erasure. Everything routine should stay silent, or the
   * field fills up with "asdf" and stops meaning anything.
   */
  requireTypedReason?: boolean;
  /**
   * Performs the write. Resolve → the dialog closes. Reject → the dialog stays
   * open and shows the failure, so the typed reason is not lost.
   */
  onConfirm: (reason: string) => Promise<unknown>;
}

export function ReasonActionButton({
  label,
  title,
  description,
  confirmLabel,
  minLength,
  variant = "outline",
  size = "sm",
  disabled = false,
  disabledHint,
  requireTypedReason = false,
  onConfirm,
}: ReasonActionButtonProps) {
  const { employee } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The reason nobody has to type.
   *
   * `title` is the imperative description of this exact action, already carrying its
   * subject through i18n interpolation — "Issue a pairing code for TT-GATE-01",
   * "Revoke TT-GATE-01". Prefixed with the surface so a reader of `audit_log` can
   * tell a console action from an edge-function one or a migration, and suffixed with
   * the actor's name when we know it, which is what a human actually wants to see
   * first in an audit row.
   *
   * `audit.reason_required_tables` demands at least 10 characters and several call
   * sites raise that to 15; every title in this product is comfortably longer, and
   * the assertion below fails loudly rather than letting a short one reach a trigger
   * that would reject the write with a database error the admin cannot act on.
   */
  const derivedReason = (() => {
    const who = employee?.displayName ?? null;
    const base = who === null
      ? `admin console: ${title}`
      : `admin console: ${title} — by ${who}`;
    // Belt and braces for a future title shorter than the DB floor.
    return base.length >= 20 ? base : `${base} (recorded from the admin console)`;
  })();

  /** Resolves `true` on success. The caller needs to know, to decide what to show. */
  async function confirm(reason: string): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await onConfirm(reason);
      setOpen(false);
      return true;
    } catch (e) {
      setError(mutationUserMessage(e));
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        aria-describedby={undefined}
        onClick={() => {
          setError(null);
          // No dialog unless the circumstance genuinely needs describing. The write
          // still carries a reason — a derived one — so the DB trigger is satisfied
          // and the audit row is complete.
          if (requireTypedReason) {
            setOpen(true);
            return;
          }
          // SILENT ON SUCCESS, VISIBLE ON FAILURE. Firing straight away with no
          // dialog means a rejected write would otherwise set an error nobody
          // renders — the button would look like it did nothing. On failure the
          // dialog opens carrying the server's sentence, which also gives the admin
          // somewhere to say what they were trying to do if they want to.
          void confirm(derivedReason).then((ok) => {
            if (!ok) setOpen(true);
          });
        }}
      >
        {label}
      </Button>
      <ReasonDialog
        open={open}
        title={title}
        description={description}
        actorName={employee?.displayName ?? null}
        {...(minLength !== undefined ? { minLength } : {})}
        {...(confirmLabel !== undefined ? { confirmLabel } : {})}
        pending={pending}
        errorMessage={error}
        onConfirm={(reason) => void confirm(reason)}
        onCancel={() => {
          if (pending) return;
          setError(null);
          setOpen(false);
        }}
      />
    </>
  );
}
