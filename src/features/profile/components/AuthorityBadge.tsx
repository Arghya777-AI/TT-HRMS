/**
 * AuthorityBadge.tsx — the edit-authority model, made visible.
 *
 * spec-employee §6 says enforcement lives in three server layers and "UI markers
 * are convenience only". True — but the convenience is the whole feature request:
 * an employee must be able to SEE that their legal name needs HR approval and
 * their designation is not theirs to change, rather than discovering it when a
 * save fails or, worse, appears to succeed and silently reverts.
 *
 * So each marker is a real, labelled, keyboard-reachable element with a tooltip,
 * not a decorative dot. The legend renders once per card so the three markers are
 * explained where they are used, not in a help page nobody opens.
 */
import { Check, Lock, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  AUTHORITY_HINT_KEY,
  AUTHORITY_LABEL_KEY,
  VISIBLE_AUTHORITIES,
  type EditAuthority,
} from "../types";

const ICON: Record<EditAuthority, ComponentType<{ className?: string }>> = {
  self: Check,
  maker_checker: ShieldCheck,
  admin_only: Lock,
  admin_hidden: Lock,
};

/**
 * Tone choices are deliberate: self-edit is positive, maker-checker is a caution
 * (something will happen after you act), admin-only is neutral-muted rather than
 * "danger" — an HR-owned field is normal, not an error (DR-45 in spirit).
 */
const TONE: Record<EditAuthority, string> = {
  self: "border-success/40 bg-success/10 text-success",
  maker_checker: "border-warning/40 bg-warning/10 text-warning",
  admin_only: "border-border bg-muted text-muted-foreground",
  admin_hidden: "border-border bg-muted text-muted-foreground",
};

export interface AuthorityBadgeProps {
  authority: EditAuthority;
  /** Icon-only for dense field rows; the label stays in the accessible name. */
  compact?: boolean;
  className?: string;
}

export function AuthorityBadge({ authority, compact = false, className }: AuthorityBadgeProps) {
  const Icon = ICON[authority];
  const label = t(AUTHORITY_LABEL_KEY[authority]);
  const hint = t(AUTHORITY_HINT_KEY[authority]);

  return (
    <Tooltip>
      <TooltipTrigger
        // A button, not a span: the marker must be reachable by keyboard so the
        // explanation is available without a pointer.
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium leading-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          TONE[authority],
          className,
        )}
        aria-label={`${label}. ${hint}`}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {compact ? null : <span>{label}</span>}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <p className="font-medium">{label}</p>
        <p className="mt-0.5 text-xs opacity-90">{hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The three-marker legend. Rendered once at the top of each tab so the markers
 * beside individual fields are self-explanatory in place.
 */
export function AuthorityLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground", className)}
      aria-label={t("profile.authority.legend")}
    >
      <span className="font-medium text-foreground">{t("profile.authority.legend")}</span>
      {VISIBLE_AUTHORITIES.map((authority) => (
        <span key={authority} className="inline-flex items-center gap-1.5">
          <AuthorityBadge authority={authority} />
          <span>{t(AUTHORITY_HINT_KEY[authority])}</span>
        </span>
      ))}
    </div>
  );
}
