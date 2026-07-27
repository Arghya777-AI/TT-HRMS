/**
 * AuditListShell — the footer every keyset-paginated audit list needs, plus the
 * two honest labels that go with it.
 *
 * Why a "Load older" button rather than infinite scroll: the count on screen has
 * to be truthful. `paginate()` learns `hasMore` from `pageSize + 1` rows and
 * never issues a COUNT, so this console genuinely does not know how many events
 * match — and inventing "1–50 of 1,347" for an append-only table that is being
 * written underneath would be the reference product's disagreement defect in a
 * new place. So the label says what it knows: how many rows are loaded, and
 * whether there are more.
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";

export interface LoadMoreFooterProps {
  readonly loadedCount: number;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
  /** Label for the unit being counted, e.g. "events", "sign-ins". */
  readonly unitLabel: string;
}

export function LoadMoreFooter({
  loadedCount,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  unitLabel,
}: LoadMoreFooterProps) {
  if (loadedCount === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="num text-xs text-muted-foreground" aria-live="polite">
        {hasNextPage
          ? t("adminAudit.list.loadedMore", { n: formatNumber(loadedCount), unit: unitLabel })
          : t("adminAudit.list.loadedAll", { n: formatNumber(loadedCount), unit: unitLabel })}
      </p>
      {hasNextPage ? (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />
              {t("adminAudit.list.loading")}
            </>
          ) : (
            t("adminAudit.list.loadOlder")
          )}
        </Button>
      ) : null}
    </div>
  );
}
