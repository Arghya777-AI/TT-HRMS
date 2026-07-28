/**
 * punchPlace.api.ts — ask the server what place a punch coordinate is.
 *
 * The lookup is server-side (`supabase/functions/reverse-geocode`) for three
 * reasons that are not about convenience:
 *
 *   1. The cache lives in `public.geocode_cache`, so every admin benefits from a
 *      lookup any one of them paid for. A browser-side cache would re-ask the
 *      provider once per person per session.
 *   2. OpenStreetMap's Nominatim policy is 1 request/second for the whole
 *      application, which can only be enforced somewhere shared.
 *   3. A `GOOGLE_MAPS_API_KEY`, if one is ever configured, must never reach a
 *      browser.
 *
 * WHAT COMES BACK IS NOT ALWAYS AN ADDRESS, and the schema says so. `outcome`
 * distinguishes four endings, and the UI renders three of them differently:
 * `resolved` has a place, `not_found` means the provider is sure there is no
 * address there (a field, a lake), `provider_throttled` means we never asked and
 * the caller should try again, and `provider_error` means the attempt failed.
 * Collapsing these into "no place name" would turn a transient throttle into a
 * permanent-looking blank.
 */
import { z } from "zod";
import { invokeEdgeFn } from "@/shared/api/invoke";
import type { PunchFix } from "@/lib/punchPlace";

export const GEOCODE_FN = "reverse-geocode";

/** The four endings a lookup can have. Mirrors the function's own `Outcome`. */
export const geocodeOutcomeSchema = z.enum([
  "resolved",
  "not_found",
  "provider_error",
  "provider_throttled",
]);

export type GeocodeOutcome = z.infer<typeof geocodeOutcomeSchema>;

const partsSchema = z.object({
  name: z.string().nullable(),
  road: z.string().nullable(),
  suburb: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postcode: z.string().nullable(),
  country: z.string().nullable(),
});

/**
 * `.passthrough()` at the top level, deliberately: the function also returns
 * `requestId`, `key` and `provider`, which this client has no use for but which
 * are useful in a network trace. Being strict here would make adding a
 * diagnostic field to the function a breaking change to the UI.
 */
export const punchPlaceSchema = z
  .object({
    lat: z.number(),
    lng: z.number(),
    displayName: z.string().nullable(),
    parts: partsSchema,
    cached: z.boolean(),
    outcome: geocodeOutcomeSchema,
    /** A caller-safe sentence for every non-resolved outcome. */
    reason: z.string().nullable(),
    fetchedAt: z.string().nullable(),
  })
  .passthrough();

export type PunchPlace = z.infer<typeof punchPlaceSchema>;

/**
 * Reverse-geocode one coordinate.
 *
 * Sends only the coordinate — NOT the punch id, the employee, or anything else
 * about who was standing there. The function needs a point to look up a point,
 * and a geocode request that carried an employee id would put "who was where"
 * into a provider's logs the moment a future provider is configured.
 */
export async function fetchPunchPlace(
  fix: Pick<PunchFix, "latitude" | "longitude">,
  signal?: AbortSignal,
): Promise<PunchPlace> {
  return invokeEdgeFn(
    GEOCODE_FN,
    { lat: fix.latitude, lng: fix.longitude },
    punchPlaceSchema,
    { signal },
  );
}
