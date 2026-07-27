/**
 * AuthNotice — the inline banner the sign-in screen needs: a security statement,
 * a location status, a refusal.
 *
 * Never a toast. A sign-in refusal has to stay on screen next to the control
 * that caused it, and the security comparison ("face is weaker than a password")
 * must be readable while the choice is being made — a message that vanishes
 * after four seconds is not a disclosure.
 *
 * `role` follows the tone: an error is an alert, everything else is a status, so
 * a screen reader hears the difference. This is the admin console's `Notice`
 * pattern, kept local: the four public auth screens must not pull a module out
 * of the capability-gated admin feature into the pre-auth bundle.
 */
import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, Info, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AuthNoticeTone = "info" | "success" | "warning" | "error" | "security";

const TONE: Readonly<
  Record<AuthNoticeTone, { className: string; icon: ComponentType<{ className?: string }>; iconClass: string }>
> = {
  info: { className: "border-info/40 bg-info/5", icon: Info, iconClass: "text-info" },
  success: {
    className: "border-success/40 bg-success/5",
    icon: CheckCircle2,
    iconClass: "text-success",
  },
  warning: {
    className: "border-warning/40 bg-warning/5",
    icon: TriangleAlert,
    iconClass: "text-warning",
  },
  error: { className: "border-destructive/40 bg-destructive/5", icon: XCircle, iconClass: "text-destructive" },
  security: {
    className: "border-border bg-muted/40",
    icon: ShieldAlert,
    iconClass: "text-muted-foreground",
  },
};

export interface AuthNoticeProps {
  tone: AuthNoticeTone;
  children: ReactNode;
  /** Right-aligned slot for a retry control. */
  action?: ReactNode;
  className?: string;
}

export function AuthNotice({ tone, children, action, className }: AuthNoticeProps) {
  const { className: toneClass, icon: Icon, iconClass } = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm text-foreground",
        toneClass,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconClass)} aria-hidden />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action !== undefined ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
