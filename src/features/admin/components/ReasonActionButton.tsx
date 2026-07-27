/**
 * ReasonActionButton — a button whose only way to fire is through `ReasonDialog`.
 *
 * Every sensitive admin action on the kiosk and settings screens is this
 * component: revoke a pairing, retire a template, pull a kill switch, change a
 * threshold. Wiring it once means no screen can accidentally ship the version
 * that writes first and asks later.
 *
 * The dialog stays OPEN when the write fails, with the server's plain-English
 * sentence inside it, so the admin edits the reason instead of retyping the
 * whole change (`ReasonDialog.errorMessage` exists for exactly this).
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
  onConfirm,
}: ReasonActionButtonProps) {
  const { employee } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(reason: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onConfirm(reason);
      setOpen(false);
    } catch (e) {
      setError(mutationUserMessage(e));
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
          setOpen(true);
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
