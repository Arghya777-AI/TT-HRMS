/**
 * HomeCard.tsx — the card frame every E-02 region renders inside, plus the one
 * state machine that gives each region all seven states (§7.2 / DoD 3).
 *
 * Each region owns its own query, so a failing card shows its own error while
 * the rest of the page stays useful — that IS the partial state, rather than one
 * page-wide spinner that hides good data.
 */
import type { ComponentType, ReactNode } from "react";
import { Lock } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { QueryError, isNoPermissionError } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

export interface HomeCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** Right-aligned link/button for this region only. */
  action?: ReactNode;
  /** Extra classes for grid placement (e.g. 'lg:col-span-2'). */
  className?: string;
  children: ReactNode;
}

/** One region of the home grid: heading row + body. */
export function HomeCard({ icon: Icon, title, action, className, children }: HomeCardProps) {
  return (
    <section className={cn("rounded-lg border bg-card", className)} aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
        </h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export interface RegionBodyProps<T> {
  query: UseQueryResult<T, Error>;
  /** Region-shaped skeleton — never a bare spinner. */
  skeleton: ReactNode;
  /** True when the resolved data means "nothing to show". */
  isEmpty?: (data: T) => boolean;
  /** Action-phrased empty state (DR-06/07). */
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * Loading → skeleton; offline → honest offline note; RLS/no-employee →
 * no-permission state; other failures → ErrorState + retry; empty → the
 * region's own action-phrased empty state; success → children.
 */
export function RegionBody<T>({ query, skeleton, isEmpty, empty, children }: RegionBodyProps<T>) {
  if (query.isPending) return <>{skeleton}</>;

  if (query.isError) {
    const error = query.error;
    if (isNoPermissionError(error)) {
      return (
        <EmptyState
          icon={Lock}
          title={t("home.state.noPermission.title")}
          hint={t("home.state.noPermission.hint")}
        />
      );
    }
    if (error instanceof QueryError && error.isOffline) {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {t("home.state.offline")}
        </p>
      );
    }
    return <ErrorState error={error} retry={() => void query.refetch()} />;
  }

  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title={t("common.noRows.title")} />}</>;
  return <>{children(data)}</>;
}

/** Two rows of value skeletons — the default region placeholder. */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

/** Label above value — the one fact layout used across the home cards. */
export function Fact({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "num mt-0.5 truncate font-display text-lg font-semibold",
          tone === "warn" && "text-warning",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
