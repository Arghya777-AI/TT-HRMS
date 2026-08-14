/**
 * Notice — the small banner every admin screen needs: a success confirmation
 * after a write, a warning about something the reader may need to act on, an
 * inline error, and a standing NOTE about what a screen does not do.
 *
 * ── WHY `note` EXISTS, SEPARATELY FROM `warning` ────────────────────────────
 *
 * This product states its own boundaries on screen — a row cap, a view that
 * cannot be sliced by department, a table nobody has built yet. That habit is
 * worth keeping. But those lines were dressed as WARNINGS, in amber, behind a
 * triangle, and a client reading one asked, reasonably, "why is this error
 * coming, do we need to fix it?"
 *
 * The answer was no: it is permanent, it is architectural, and there is nothing
 * an administrator can do about it. A warning triangle that never clears is how
 * people learn to ignore warning triangles — and then miss the one that mattered.
 *
 * So `warning` is now reserved for something the READER can act on, and `note`
 * carries the standing facts: muted rather than amber, and `role="note"` rather
 * than `role="status"`, because a permanent footnote is not a live region and a
 * screen reader should not announce it as though something just happened.
 *
 * `role` is otherwise chosen by tone rather than hard-coded: a success/warning
 * line is a status, an error line is an alert. It is never a toast — a
 * confirmation that vanishes is not evidence that an audited change happened.
 */
import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "success" | "warning" | "error" | "info" | "note";

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
  /* Deliberately the quietest thing on the page: it is true, it is permanent,
     and it is not asking anybody to do anything. */
  note: {
    className: "border-border/60 bg-muted/30 text-muted-foreground",
    icon: Info,
  },
};

const ICON_TONE: Readonly<Record<NoticeTone, string>> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  info: "text-info",
  note: "text-muted-foreground/70",
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
      role={tone === "error" ? "alert" : tone === "note" ? "note" : "status"}
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
