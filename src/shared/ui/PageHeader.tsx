import type { ComponentType, ReactNode } from "react";

export interface PageHeaderProps {
  /** Lucide icon component rendered in the tinted tile. */
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  /** Right-aligned action area (buttons, period selector, export menu…). */
  actions?: ReactNode;
}

/**
 * PageHeader — icon tile + H1 + subtitle + right actions (spec-employee §0).
 * Every page renders exactly one of these at the top.
 */
export function PageHeader({ icon: Icon, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl font-semibold leading-tight">{title}</h1>
          {subtitle ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
