import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { MASKED_INR_SHAPE } from "@/lib/money";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

export type MaskedKind = "money" | "id" | "text";

export interface MaskedValueProps {
  /** The already-formatted display value (e.g. '₹2,20,000' or '50100011234567'). */
  value: string;
  /** Start masked (default true). Reveals are per-instance, never persisted. */
  masked?: boolean;
  /** Fired when the user reveals — the feature emits its `pii.revealed` audit here. */
  onReveal?: () => void;
  kind: MaskedKind;
  className?: string;
}

/** Mask preserving shape: money '₹•,••,•••' · id '••••••1234' · text '••••••' (§P4). */
function maskFor(kind: MaskedKind, value: string): string {
  switch (kind) {
    case "money":
      return MASKED_INR_SHAPE;
    case "id": {
      const compact = value.replace(/\s+/g, "");
      if (compact.length <= 4) return "•".repeat(Math.max(4, compact.length));
      return `${"•".repeat(6)}${compact.slice(-4)}`;
    }
    case "text":
      return "••••••";
  }
}

/**
 * Masked-by-default sensitive value with an inline reveal toggle (§P4: masked by
 * default, reveal is an audited event — wire the audit through `onReveal`).
 */
export function MaskedValue({ value, masked = true, onReveal, kind, className }: MaskedValueProps) {
  const [revealed, setRevealed] = useState(!masked);

  function toggle() {
    setRevealed((prev) => {
      const next = !prev;
      if (next) onReveal?.();
      return next;
    });
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("num", kind === "id" && "font-mono", !revealed && "masked")}>
        {revealed ? value : maskFor(kind, value)}
      </span>
      <button
        type="button"
        onClick={toggle}
        aria-label={revealed ? t("common.hide") : t("common.reveal")}
        aria-pressed={revealed}
        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
