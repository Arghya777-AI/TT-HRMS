/**
 * RevealPanel.tsx — the step-up control in front of an audited reveal.
 *
 * The server demands a written purpose of ≥10 characters before
 * `reveal_employee_statutory` / `reveal_employee_bank_account` return anything, and
 * it writes that purpose into `data_access_log` alongside the actor. So the reason
 * box is not UI theatre: whatever is typed here is what the subject of the data
 * reads back on their History tab under "Who looked at my details".
 *
 * The refusal path is a first-class outcome, not an error toast. For a normal
 * employee the correct answer is "the full number is never sent to your browser" —
 * migration 033 does not grant the column and migration 032 gates the function on
 * `app.is_admin()`. Saying that plainly is more useful than a red banner.
 */
import { useId, useState } from "react";
import { Eye, Info, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/shared/i18n/en";
import { REVEAL_REASON_MIN_LENGTH } from "../api/payment.api";
import { isRevealForbidden } from "../hooks/useReveal";

export interface RevealPanelProps {
  /** What is being revealed, for the accessible name: "statutory ids", "bank". */
  what: string;
  onReveal: (reason: string) => void;
  pending: boolean;
  error: unknown;
  /** True once a reveal has succeeded — the control collapses to a note. */
  revealed: boolean;
  onHide: () => void;
}

export function RevealPanel({
  what,
  onReveal,
  pending,
  error,
  revealed,
  onHide,
}: RevealPanelProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const forbidden = isRevealForbidden(error);
  const tooShort = reason.trim().length < REVEAL_REASON_MIN_LENGTH;

  if (revealed) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-success">{t("profile.reveal.recorded")}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onHide();
            setOpen(false);
            setReason("");
          }}
        >
          {t("common.hide")}
        </Button>
      </div>
    );
  }

  if (forbidden) {
    return (
      <p className="flex max-w-md items-start gap-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("profile.reveal.forbidden")}</span>
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t("profile.reveal.action")}
      </Button>
    );
  }

  return (
    <form
      className="w-full max-w-md space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tooShort) onReveal(reason.trim());
      }}
    >
      <Label htmlFor={reasonId} className="text-xs">
        {t("profile.reveal.reasonLabel", { what })}
      </Label>
      <Input
        id={reasonId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("profile.reveal.reasonPlaceholder")}
        minLength={REVEAL_REASON_MIN_LENGTH}
        autoComplete="off"
      />
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <span>{t("profile.reveal.auditNote", { min: REVEAL_REASON_MIN_LENGTH })}</span>
      </p>
      {error != null && !forbidden ? (
        <p className="text-xs text-destructive" role="alert">
          {error instanceof Error ? error.message : t("error.hint")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={tooShort || pending}>
          {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {t("profile.reveal.confirm")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setReason("");
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
