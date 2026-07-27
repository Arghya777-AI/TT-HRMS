import type { ComponentType, ReactNode } from "react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  /** One action-phrased line — never a raw status dump (DR-04/06/07). */
  hint?: string;
  action?: ReactNode;
}

/** Contextual empty state. Always phrased with an action/benefit, never blank. */
export function EmptyState({ icon: Icon = Inbox, title, hint, action }: EmptyStateProps) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed bg-card/50 px-6 py-14 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
          <Icon className="h-6 w-6" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold">{title}</h2>
        {hint ? <p className="mt-1.5 text-sm text-muted-foreground">{hint}</p> : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}
