/**
 * Notice — the small banner every admin screen needs three of: a success
 * confirmation after a write, a warning about a boundary the screen is honest
 * about (a row cap, a missing server endpoint), and an inline error.
 *
 * `role` is chosen by tone rather than hard-coded: a success/warning line is a
 * status, an error line is an alert, and a screen reader should hear the
 * difference. It is never a toast — a confirmation that vanishes is not evidence
 * that an audited change happened.
 */
import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "success" | "warning" | "error" | "info";

const TONE: Readonly<
  Record<NoticeTone, { className: string; icon: ComponentType<{ className?: string }> }>
> = {
  success: {
    className: "border-success/40 bg-success/5 text-foreground",
    icon: CheckCircle2,
  },
  warning: {
    className: "border-warning/40 bg-warning/5 text-foreground",
    icon: TriangleAlert,
  },
  error: {
    className: "border-destructive/40 bg-destructive/5 text-foreground",
    icon: XCircle,
  },
  info: { className: "border-info/40 bg-info/5 text-foreground", icon: Info },
};

const ICON_TONE: Readonly<Record<NoticeTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  info: "text-info",
};

export interface NoticeProps {
  tone: NoticeTone;
  children: ReactNode;
  /** Right-aligned slot for a "Dismiss"/"Undo"-style control. */
  action?: ReactNode;
  className?: string;
}

export function Notice({ tone, children, action, className }: NoticeProps) {
  const { className: toneClass, icon: Icon } = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm",
        toneClass,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ICON_TONE[tone])} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
