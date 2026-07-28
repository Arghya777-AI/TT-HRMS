/**
 * usePunchPlace — the place name for one punch coordinate.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE QUERY KEY IS THE WHOLE DESIGN
 *
 * The key is the coordinate ROUNDED to `geocodeKey`'s ~11 m square, not the punch
 * id and not the raw coordinate. React Query dedupes by key, so:
 *
 *   - Fifty punches taken at one gate share ONE request and ONE cache entry.
 *   - A punch log renders every row's place name at the cost of one lookup per
 *     distinct place, which is what makes Nominatim's 1 request/second ceiling
 *     survivable at all.
 *   - Two components showing the same punch (a timeline row and a detail panel)
 *     never ask twice.
 *
 * Keying on the punch id instead would issue one request per row — for a busy day
 * that is 100+ provider calls for maybe four actual places, and every one after
 * the first second would come back `provider_throttled`.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * CACHED FOR A DAY, BECAUSE PLACES DO NOT MOVE
 *
 * A street address for a coordinate is stable in a way almost nothing else in
 * this app is. The server caches resolved answers with no expiry at all; the
 * browser holding it for a working day just avoids re-asking across navigations.
 *
 * A THROTTLE IS NOT AN ANSWER, so it is not treated as one. `provider_throttled`
 * means we never reached the provider: the query is marked stale immediately and
 * retried, because the alternative is a row that says "could not look this up"
 * for a day when the real reason was that four other rows went first.
 *
 * `provider_error` and `not_found` ARE answers — the server negative-caches them
 * with short TTLs of its own — so they are left alone here.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { geocodeKey, type PunchFix } from "@/lib/punchPlace";
import { fetchPunchPlace, type PunchPlace } from "../api/punchPlace.api";

/** A working day. Long, because an address for a coordinate does not change. */
const PLACE_STALE_MS = 8 * 60 * 60 * 1_000;

/** Shared so a caller can invalidate or prime the same entry a hook would read. */
export function punchPlaceQueryKey(fix: Pick<PunchFix, "latitude" | "longitude">): string[] {
  return ["punch-place", geocodeKey(fix)];
}

export function usePunchPlace(
  fix: Pick<PunchFix, "latitude" | "longitude"> | null,
): UseQueryResult<PunchPlace, Error> {
  return useQuery({
    // `fix!` is safe under `enabled`, but the key must still be computable when
    // disabled — React Query builds the key regardless of whether it runs.
    queryKey: fix === null ? ["punch-place", "none"] : punchPlaceQueryKey(fix),
    queryFn: ({ signal }) => {
      if (fix === null) {
        // Unreachable under `enabled: false`; throwing beats a cast that would
        // let a null slip to the network layer if `enabled` ever changed.
        throw new Error("usePunchPlace: queryFn ran with no coordinate");
      }
      return fetchPunchPlace(fix, signal);
    },
    // Most punches have no coordinate at all. Not a failure — nothing to ask.
    enabled: fix !== null,
    staleTime: (query) => {
      // A throttle means the provider was never reached, so nothing was learned.
      // Zero stale time lets the next render re-ask instead of caching our own
      // rate limiter as if it were a fact about the place.
      const outcome = query.state.data?.outcome;
      return outcome === "provider_throttled" ? 0 : PLACE_STALE_MS;
    },
    gcTime: PLACE_STALE_MS,
    // One retry, for exactly the throttle case. A 401/403 or a missing capability
    // will not fix itself, and retrying a refusal three times per row turns a
    // permissions problem into a burst of pointless traffic.
    retry: (attempt, error) => attempt < 1 && !isRefusal(error),
    retryDelay: 1_200,
    // The place name is decoration on a row that already renders; refetching it
    // when the tab regains focus would re-ask for every visible punch.
    refetchOnWindowFocus: false,
  });
}

/** A 4xx that will not resolve by asking again. */
function isRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}
