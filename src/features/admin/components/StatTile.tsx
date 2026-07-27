/**
 * StatTile — a server COUNT rendered above the very rows it counts.
 *
 * Why this exists next to `CountTile` rather than instead of it: `CountTile` is
 * the Command Centre tile, and there `to` is REQUIRED because a number an admin
 * cannot open is a dead end (spec-admin §2.1). A section figure on a screen that
 * already lists the rows underneath it has nowhere to drill TO — its drill is the
 * grid two inches below — so a required route would only ever be a link back to
 * the page you are already on.
 *
 * Everything else is deliberately identical to `CountTile`:
 *   * All the states in one place. Pending → a skeleton; failed → `—` PLUS the
 *     reason, never a plausible-looking `0`. A zero here means Postgres counted
 *     zero rows, and it has to keep meaning exactly that.
 *   * The mandatory `(i)` explainer says, in words, which list the figure counts.
 *     There is no formula, because there is no arithmetic: the figure IS a
 *     `count=exact` over the same predicate the grid uses.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { KpiTile } from "@/shared/ui/KpiTile";
import type { StatusTone } from "@/shared/ui/StatusChip";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { unavailableHint } from "../command-vocab";
import type { CountState } from "./CountTile";

export interface StatTileProps {
  label: string;
  /** One line under the number: what is being counted, in words. */
  hint: string;
  /** The list this counts, named in words for the explainer — never a view name. */
  source: string;
  query: CountState;
  /** Colour from the value, e.g. "warn when anything is unmanaged". */
  toneFor?: (count: number) => StatusTone;
}

export function StatTile({ label, hint, source, query, toneFor }: StatTileProps) {
  if (query.isPending) {
    return <KpiTile label={label} value={<Skeleton className="h-7 w-12" />} hint={t("admin.cc.tile.loading")} />;
  }

  if (query.error !== null) {
    return (
      <KpiTile
        label={label}
        value={t("common.empty")}
        hint={unavailableHint(query.error)}
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
      {...(toneFor ? { tone: toneFor(count) } : {})}
      explainer={{
        formula: t("admin.cc.explainer.formula", { source }),
        numbers: t("admin.cc.explainer.numbers", { count: formatNumber(count), source }),
      }}
    />
  );
}
