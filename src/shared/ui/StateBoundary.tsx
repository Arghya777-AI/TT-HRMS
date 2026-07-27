/**
 * StateBoundary — the seven states of a screen section, in one place
 * (frontend-contract §8.3: loading skeleton, empty, error+retry, partial,
 * offline, no-permission, success).
 *
 * Every screen section wraps its content in this so a failed read can never
 * render as a plausible-looking zero. The branch order matters: offline and
 * no-permission are DISTINCT from a generic error because the honest thing to
 * show differs — one says "reconnect", the other says "this isn't yours".
 */
import type { ReactNode } from "react";
import { CloudOff, Lock, TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { QueryError, isNoPermissionError } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";

export interface StateBoundaryProps {
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** True when the read succeeded but returned nothing. */
  isEmpty?: boolean;
  /** Action-phrased empty state (DR-06/07). Falls back to a generic one. */
  empty?: ReactNode;
  /**
   * A secondary read that failed while the primary succeeded — the PARTIAL
   * state. Content still renders, with an honest banner above it.
   */
  partialError?: unknown;
  /** What the partial banner says is missing, e.g. "your quota". */
  partialLabel?: string;
  skeletonRows?: number;
  children: ReactNode;
}

function LoadingBlock({ rows }: { rows: number }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{t("app.loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

function OfflineBlock({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      className="grid place-items-center rounded-lg border border-warning/40 bg-warning/5 px-6 py-12 text-center"
      role="status"
    >
      <div className="max-w-sm">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-warning/10 text-warning" aria-hidden>
          <CloudOff className="h-6 w-6" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold">{t("states.offline.title")}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("states.offline.hint")}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
            {t("error.retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function NoPermissionBlock() {
  return (
    <div className="grid place-items-center rounded-lg border bg-card px-6 py-12 text-center" role="status">
      <div className="max-w-sm">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
          <Lock className="h-6 w-6" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold">{t("states.noPermission.title")}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("states.noPermission.hint")}</p>
      </div>
    </div>
  );
}

export function PartialBanner({ label }: { label?: string }) {
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
      role="status"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>{label ? t("states.partial.hintNamed", { what: label }) : t("states.partial.hint")}</span>
    </div>
  );
}

export function StateBoundary({
  loading = false,
  error,
  onRetry,
  isEmpty = false,
  empty,
  partialError,
  partialLabel,
  skeletonRows = 3,
  children,
}: StateBoundaryProps) {
  if (loading) return <LoadingBlock rows={skeletonRows} />;

  if (error !== undefined && error !== null) {
    if (error instanceof QueryError && error.isOffline) return <OfflineBlock {...(onRetry ? { onRetry } : {})} />;
    if (isNoPermissionError(error)) return <NoPermissionBlock />;
    return <ErrorState error={error} {...(onRetry ? { retry: onRetry } : {})} />;
  }

  if (isEmpty) return <>{empty ?? <EmptyState title={t("common.noRows.title")} />}</>;

  return (
    <>
      {partialError !== undefined && partialError !== null ? (
        <PartialBanner {...(partialLabel ? { label: partialLabel } : {})} />
      ) : null}
      {children}
    </>
  );
}
