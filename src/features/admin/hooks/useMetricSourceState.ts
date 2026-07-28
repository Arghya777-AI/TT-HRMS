/**
 * useMetricSourceState — asks whether a declared-but-unbuilt metric can start working
 * yet, so the dashboard turns it on without anybody remembering to.
 *
 * THE PROBE. One HEAD-style request for a single row against the relation the metric
 * declared. Three outcomes, and the middle one is the reason this exists:
 *
 *   relation missing (PGRST205) -> "planned"   — nobody has built the table
 *   exists, zero rows           -> "awaiting"  — built, but nothing recorded yet
 *   exists, has rows            -> "live"      — the caller renders the real metric
 *
 * "We built the recruitment module and nobody has entered a requisition" and "we never
 * built it" look identical on a dashboard that only knows empty-vs-not, and they send
 * you to two different teams.
 *
 * FAILURE IS NOT "LIVE". A network error, a 401, an RLS refusal — anything that is not
 * a clean answer — resolves to `planned`. The alternative is a card that flips to a
 * real metric and then renders nothing, which is the failure mode this whole mechanism
 * exists to avoid. Being pessimistic here costs a muted card; being optimistic costs
 * trust in the number.
 *
 * Cached for the session: whether a TABLE exists changes at deploy time, not while
 * somebody is reading a chart, so re-probing on every mount is pure noise.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  resolveMetricState,
  type MetricSourceState,
  type PlannedMetric,
} from "../analyticsCapabilities";

/** A whole working day: table existence is a deploy-time fact. */
const PROBE_STALE_MS = 8 * 60 * 60 * 1_000;

export async function probeMetricSource(relation: string): Promise<MetricSourceState> {
  const { count, error } = await supabase
    .from(relation)
    .select("*", { count: "exact", head: true });

  // EVERY failure is `planned`, deliberately and without inspecting the code. The
  // relation-absent code says "not built"; RLS, auth and network failures say
  // nothing at all — and an unknown must not present as data, so both collapse to
  // the muted card. (This was written as a ternary on RELATION_ABSENT_CODE whose
  // two branches were the same value, which read as a distinction being drawn.)
  if (error !== null) return "planned";
  return resolveMetricState({ relationExists: true, rowCount: count ?? 0 });
}

export function useMetricSourceState(metric: PlannedMetric): UseQueryResult<MetricSourceState, Error> {
  return useQuery({
    queryKey: ["analytics", "metric-source", metric.key],
    queryFn: () =>
      metric.relation === null
        ? // A metric needing more than one new relation cannot resolve itself by
          // probing a single name — see `isSelfResolving`. It stays planned until
          // somebody wires it deliberately.
          Promise.resolve<MetricSourceState>("planned")
        : probeMetricSource(metric.relation),
    staleTime: PROBE_STALE_MS,
    gcTime: PROBE_STALE_MS,
    // A missing table is not a transient fault; retrying just delays the card.
    retry: false,
  });
}
