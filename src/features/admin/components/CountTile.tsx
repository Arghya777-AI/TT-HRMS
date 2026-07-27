/**
 * CountTile — a Command Centre tile whose number came from a server COUNT.
 *
 * Why this wrapper exists rather than 12 hand-rolled tiles:
 *
 *  * It renders ALL SEVEN states in one place. A tile that cannot be read shows
 *    `—` plus the reason (offline / not yours / this screen is out of step),
 *    never a plausible-looking `0`. A zero on this screen means "the database
 *    counted zero rows", and it has to keep meaning exactly that.
 *  * It carries the drill-through. `to` is required, because a number an admin
 *    cannot open is a dead end (spec-admin §2.1).
 *  * It carries the explainer. The `(i)` popover states, in words and with this
 *    admin's own number, where the figure came from — no formula, because there
 *    is no arithmetic: the figure IS a row count.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { KpiTile } from "@/shared/ui/KpiTile";
import type { StatusTone } from "@/shared/ui/StatusChip";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { unavailableHint } from "../command-vocab";

/** The subset of `UseQueryResult` a tile needs — keeps this testable. */
export interface CountState {
  data: number | undefined;
  error: Error | null;
  isPending: boolean;
}

export interface CountTileProps {
  label: string;
  /** One line under the number: what is being counted, in words. */
  hint: string;
  /** Where the number opens. Required — a tile with no route is a defect. */
  to: string;
  /** Accessible name for the drill link, e.g. "Open the exception dashboard". */
  drillLabel: string;
  /** The list this counts, named in words for the explainer (never a view name). */
  source: string;
  query: CountState;
  /** Colour from the value, e.g. "danger when anything is waiting". */
  toneFor?: (count: number) => StatusTone;
}

export function CountTile({
  label,
  hint,
  to,
  drillLabel,
  source,
  query,
  toneFor,
}: CountTileProps) {
  if (query.isPending) {
    return (
      <KpiTile
        label={label}
        value={<Skeleton className="h-7 w-12" />}
        hint={t("admin.cc.tile.loading")}
        to={to}
        drillLabel={drillLabel}
      />
    );
  }

  if (query.error !== null) {
    return (
      <KpiTile
        label={label}
        value={t("common.empty")}
        hint={unavailableHint(query.error)}
        to={to}
        drillLabel={drillLabel}
        explainer={{
          formula: t("admin.cc.explainer.formula", { source }),
          numbers: unavailableHint(query.error),
        }}
      />
    );
  }

  const count = query.data ?? 0;
  return (
    <KpiTile
      label={label}
      value={formatNumber(count)}
      hint={hint}
      to={to}
      drillLabel={drillLabel}
      {...(toneFor ? { tone: toneFor(count) } : {})}
      explainer={{
        formula: t("admin.cc.explainer.formula", { source }),
        numbers: t("admin.cc.explainer.numbers", { count: formatNumber(count), source }),
      }}
    />
  );
}
