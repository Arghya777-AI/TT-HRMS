/**
 * useAnalyticsFilters — the one binding between `AnalyticsFilters` and the URL.
 *
 * Every analytics surface calls this, `AnalyticsFilterBar` included, so the bar
 * and the page it sits on are reading the SAME object rather than two parses of
 * the same query string that could disagree about a malformed param. There is no
 * `useState` anywhere in the chain: the address bar is the state, which is what
 * makes a filtered view bookmarkable, reloadable and — the point the client made
 * about "click more data, click more data" — inheritable by a drill-through.
 *
 * `replace: true` on every write, matching the audit console (`audit/url-state.ts`):
 * nudging a period four times must not cost four presses of Back to leave the
 * screen. The drill-through link is what earns a history entry, not a dropdown.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { filtersFromParams, type AnalyticsFilters } from "@/lib/analyticsFilters";
import { filterParams } from "../analyticsFilterBar";

export interface AnalyticsFilterState {
  /** Parsed from the URL. Total — a hand-trimmed query string degrades to this month. */
  readonly filters: AnalyticsFilters;
  /** Write a whole filter set back, preserving params this model does not own. */
  readonly setFilters: (next: AnalyticsFilters) => void;
}

export function useAnalyticsFilters(): AnalyticsFilterState {
  const [params, setParams] = useSearchParams();
  // `params` is a fresh object on every navigation, so its STRING form is what
  // keeps the parsed filters referentially stable across unrelated re-renders —
  // otherwise every consumer's `useMemo`/`useQuery` key churns on each render.
  const search = params.toString();

  const filters = useMemo(() => filtersFromParams(new URLSearchParams(search)), [search]);

  const setFilters = useCallback(
    (next: AnalyticsFilters) => {
      setParams(filterParams(new URLSearchParams(search), next), { replace: true });
    },
    [search, setParams],
  );

  return { filters, setFilters };
}
