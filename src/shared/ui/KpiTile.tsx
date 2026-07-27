import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/shared/ui/StatusChip";

export interface KpiExplainer {
  /** The formula in words, e.g. "Paid days ÷ elapsed days × 100". */
  formula: string;
  /** The viewer's own numbers substituted, e.g. "16.0 of 25 elapsed = 64.0%". */
  numbers: string;
}

export interface KpiTileProps {
  label: string;
  /** Always a value — '0h 00m' is a value; use '—' only for unknown (§9). */
  value: ReactNode;
  hint?: string;
  tone?: StatusTone;
  /** (i) popover content; opening it is where features emit `kpi.explainer.opened`. */
  explainer?: KpiExplainer;
  onExplainerOpen?: () => void;
  /**
   * Router path this tile drills into. The whole card becomes the hit area (ONE
   * link, via an ::after overlay) while the (i) popover stays a separate control
   * layered above it. A number with no route is a defect (spec-admin §2.1).
   */
  to?: string;
  /** Accessible name for the drill link when the label alone is ambiguous. */
  drillLabel?: string;
}

const TONE_VALUE_CLASS: Record<StatusTone, string> = {
  success: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
  info: "text-info",
  neutral: "text-foreground",
};

/** KPI tile with the mandatory (i) explainer slot (spec-employee §3.7). */
export function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
  explainer,
  onExplainerOpen,
  to,
  drillLabel,
}: KpiTileProps) {
  const valueClass = cn(
    "num mt-2 font-display text-2xl font-semibold leading-none",
    TONE_VALUE_CLASS[tone],
  );

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-card p-4",
        to !== undefined &&
          "transition-colors focus-within:border-primary/50 hover:border-primary/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="relative z-10 flex items-center gap-1">
          {explainer ? (
            <Popover onOpenChange={(open) => open && onExplainerOpen?.()}>
              <PopoverTrigger
                className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`How ${label} is calculated`}
              >
                <Info className="h-3.5 w-3.5" />
              </PopoverTrigger>
              <PopoverContent className="w-80 text-sm" align="end">
                <p className="font-medium">{explainer.formula}</p>
                <p className="mt-1.5 text-muted-foreground">{explainer.numbers}</p>
              </PopoverContent>
            </Popover>
          ) : null}
          {to !== undefined ? (
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          ) : null}
        </div>
      </div>
      {to !== undefined ? (
        <Link
          to={to}
          aria-label={drillLabel ?? label}
          className={cn(
            valueClass,
            "block rounded after:absolute after:inset-0 after:content-['']",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {value}
        </Link>
      ) : (
        <p className={valueClass}>{value}</p>
      )}
      {hint ? <p className="relative z-10 mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
