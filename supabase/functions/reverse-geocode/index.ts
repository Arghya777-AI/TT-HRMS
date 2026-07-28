/**
 * reverse-geocode — turn a punch coordinate into the place name a human reads.
 * Auth model **U+** (user JWT + capability, step-up decided by the database).
 *
 * WHAT THIS IS FOR, IN THE CLIENT'S WORDS
 * ---------------------------------------
 *   "Instead of this that you need to do, just show the actual location. Show the
 *    pinpointed location, the precise location. Also show the exact place name in
 *    the details, like how Google Maps shows in details."
 *
 * Geofencing is dropped as a product idea. The punch log stops asking "was this
 * inside a boundary" and starts answering "where was this". Every punch that had
 * a fix already carries lat/lng/location_accuracy_m — both the web self-punch and
 * the gate kiosk write them — so all that was missing is the human string, and
 * that has to come from a reverse geocoder.
 *
 * CONTRACT
 * --------
 *   POST { lat, lng }  ->  200 {
 *     lat, lng, key, displayName, parts, cached, provider, outcome, reason,
 *     fetchedAt, requestId
 *   }
 *
 * `displayName` is the full line ("Tamarind Tree, 12th Main Road, Indiranagar,
 * Bengaluru, Karnataka 560038"); `parts` is the same thing broken up, so a caller
 * can render one line in a grid cell and the components in a detail panel.
 *
 * A PROVIDER FAILURE IS NOT THIS ENDPOINT'S FAILURE
 * -------------------------------------------------
 * Every path returns 200. When the geocoder times out, refuses, or has nothing at
 * that coordinate, the answer is the coordinate back with `displayName: null`, an
 * `outcome` and a `reason`. That is deliberate and it is the most important
 * decision in this file: the caller is a punch log, and an attendance record must
 * never look broken or unreadable because a third party we do not control was
 * down. A 502 here would put an error state on a row whose data is perfectly
 * intact. The failure is still visible — in `outcome`, in `reason`, and in a
 * `warn` log line — just not in a way that damages the page.
 *
 * CACHE FIRST, ALWAYS
 * -------------------
 * `public.geocode_cache` (migration 075) is keyed on the coordinate rounded to
 * 4 dp — about an 11 m square — so one gate is one row no matter how many
 * hundreds of punches happen at it. The lookup runs the SAME expression as the
 * table's generated key columns (`util.geocode_key(<coord>::numeric(9,6))`), so a
 * hit is guaranteed for any coordinate inside the square rather than merely
 * likely. Failures are cached too, briefly: a coordinate the provider cannot
 * resolve must not re-ask on every page render.
 *
 * PROVIDERS
 * ---------
 * Nominatim (OpenStreetMap) by default: no API key, works the moment this is
 * deployed. Its usage policy is strict and enforced here, not hoped for — a
 * descriptive User-Agent identifying this application, and an absolute ceiling of
 * one request per second across the WHOLE deployment via a Postgres token bucket
 * that every isolate shares (`RATE_LIMITS.nominatim`).
 *
 * Google Geocoding is used INSTEAD whenever `GOOGLE_MAPS_API_KEY` is present in
 * the function's secrets, because the client referred to Google's detail quality.
 * The key is read with `Deno.env.get` inside the function and never leaves it;
 * nothing about this endpoint puts a geocoding key in the client bundle, which is
 * the other reason the lookup is server-side at all.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem } from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowIso, toIso } from "../_shared/datetime.ts";
import { firstRow, requestIdFrom, sql as sqlHandle } from "../_shared/db.ts";
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS, tryTake } from "../_shared/ratelimit.ts";

const FN_NAME = "reverse-geocode";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * The capability that already governs reading punch detail: migration 050 seeds
 * `admin.access` on the admin role, and `src/app/route-manifest.ts` guards
 * `/admin/attendance/punches` — the screen this exists for — with exactly it. No
 * new capability name is invented here.
 *
 * Why not something an employee holds, when an employee can already read their
 * own punch's lat/lng under `attendance_punches__self_read`? Because this endpoint
 * takes a bare coordinate rather than a punch id, so a capability every employee
 * holds would turn our (rate-limited, policy-bound) geocoder budget into a free
 * geocoding API for the whole staff. A self-service place name is a separate
 * decision that has to prove the coordinate belongs to the caller's own punch;
 * this function deliberately does not attempt it.
 *
 * `requireCapWithStepUp` also reads `role_capabilities.requires_step_up`, so if
 * this ever needs aal2 it is a one-row UPDATE, not a redeploy.
 */
const CAP_READ_PUNCH_DETAIL = "admin.access";

/**
 * Nominatim asks for "a valid HTTP Referer or User-Agent identifying the
 * application" and treats a generic or absent one as grounds for blocking. This
 * names the product, the deployment and a contact route.
 */
const NOMINATIM_USER_AGENT =
  "TamarindTreeHRMS/1.0 (attendance punch location lookup; +https://hr.thetamarindtree.in)";

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * A geocoder is a page-render dependency, so it gets a short leash. Six seconds
 * is long enough for a cold Nominatim response over a bad link and short enough
 * that a hung provider does not hold an isolate open.
 */
const PROVIDER_TIMEOUT_MS = 6_000;

/**
 * How long a FAILURE is remembered. Both are deliberately short — this is a
 * negative cache to stop a bad coordinate hammering the provider on every render,
 * not a verdict.
 *   provider_error: 15 min. Timeouts and 5xx are transient; the shorter the
 *                   window, the sooner an outage heals itself with no operator.
 *   not_found:      60 min. The provider ANSWERED, authoritatively, that there is
 *                   no address there, so re-asking sooner is pure waste — but
 *                   coverage does improve (OSM is edited continuously), so it is
 *                   still not permanent.
 */
const ERROR_TTL_MINUTES = 15;
const NOT_FOUND_TTL_MINUTES = 60;

/**
 * How long to wait for the global 1-request-per-second Nominatim token before
 * giving up and degrading. One retry after ~1.1 s: two concurrent admins looking
 * at two new gates both get an answer, while the 1/s ceiling is still absolute
 * because the bucket — not this sleep — is what grants the token.
 */
const NOMINATIM_TOKEN_WAIT_MS = 1_100;

/** `outcome` on `public.geocode_cache`, plus the one state that is never stored. */
type Outcome = "resolved" | "not_found" | "provider_error" | "provider_throttled";
type Provider = "nominatim" | "google";

/**
 * A coordinate may arrive as a JSON number or as the string PostgREST returns for
 * a `numeric` column — `attendance_punches.lat` is numeric, so the punch log holds
 * "12.926880", not 12.92688. Both are accepted; nothing else is.
 *
 * `z.coerce.number()` is NOT used on purpose: it turns "" and null into 0, which
 * would silently reverse-geocode the Gulf of Guinea instead of rejecting the
 * request.
 */
const numericText = z
  .string()
  .trim()
  .regex(/^[+-]?(\d+(\.\d*)?|\.\d+)$/, "Expected a decimal number.");

function coordinate(min: number, max: number, label: string) {
  return z
    .union([z.number(), numericText])
    .transform((value) => (typeof value === "number" ? value : Number(value)))
    .refine(
      (value) => Number.isFinite(value) && value >= min && value <= max,
      `Expected a ${label} between ${min} and ${max}.`,
    );
}

const Body = z
  .object({
    lat: coordinate(-90, 90, "latitude"),
    lng: coordinate(-180, 180, "longitude"),
  })
  .strict();

/** The address, split up. Every field is optional at the provider, so all nullable. */
interface AddressParts {
  name: string | null;
  road: string | null;
  suburb: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}

const EMPTY_PARTS: AddressParts = {
  name: null,
  road: null,
  suburb: null,
  city: null,
  state: null,
  postcode: null,
  country: null,
};

/** What a provider call produced. `raw` is the provider's own address block. */
interface Lookup {
  outcome: Outcome;
  displayName: string | null;
  parts: AddressParts;
  providerPlaceId: string | null;
  raw: Record<string, unknown>;
  /** Caller-safe sentence, set for every non-resolved outcome. */
  reason: string | null;
}

/** Row shape of the cache read. Narrow interface, one cast at the call site. */
interface CacheRow {
  outcome: string;
  display_name: string | null;
  place_name: string | null;
  road: string | null;
  suburb: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  provider: string;
  failure_reason: string | null;
  fetched_at: Date | string;
  lat_key: string;
  lng_key: string;
  hit_count: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Trimmed, length-capped, or null. Provider strings are somebody else's data. */
function text(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/** First non-null of several provider field names — they disagree about naming. */
function pick(source: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = text(source[key]);
    if (found !== null) return found;
  }
  return null;
}

function isProvider(value: string): value is Provider {
  return value === "nominatim" || value === "google";
}

function isOutcome(value: string): value is Outcome {
  return value === "resolved" || value === "not_found" || value === "provider_error" ||
    value === "provider_throttled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A provider place id is a string at Google and a NUMBER at Nominatim. One
 * normaliser rather than a ternary at each call site.
 */
function placeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value, 200);
}

/**
 * The coordinate as the DATABASE will hold it: exactly six decimal places, the
 * scale of `geocode_cache.lat`/`lng`.
 *
 * Sent as text rather than as a JS number on purpose. It makes the value the
 * cache key is derived from byte-identical on the read path and the write path,
 * with no float8 round-trip in between — the one place where a mismatch would
 * quietly turn every lookup into a miss and every render into a provider call.
 */
function fixedSix(value: number): string {
  return value.toFixed(6);
}

// ═════════════════════════════════════════════════════════════════════════════
// Providers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * OpenStreetMap Nominatim. No key, immediate, and bound by a usage policy this
 * function honours: the identifying User-Agent above, and the caller having
 * already taken a token from the shared 1/s bucket.
 *
 * `zoom=18` is building-level detail — the level at which a result is a place
 * rather than a neighbourhood, which is what "the exact place name" asks for.
 */
async function fromNominatim(lat: number, lng: number): Promise<Lookup> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    method: "GET",
    headers: { "user-agent": NOMINATIM_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    return providerFailure(`Nominatim answered HTTP ${response.status}.`);
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (body === null) {
    return providerFailure("Nominatim's response could not be read as JSON.");
  }
  // Nominatim reports "no address here" as a body with an `error` key, HTTP 200.
  if (typeof body.error === "string" || body.display_name === undefined) {
    return {
      outcome: "not_found",
      displayName: null,
      parts: EMPTY_PARTS,
      providerPlaceId: null,
      raw: {},
      reason: "OpenStreetMap has no address recorded at this coordinate.",
    };
  }

  const address = (typeof body.address === "object" && body.address !== null)
    ? body.address as Record<string, unknown>
    : {};

  return {
    outcome: "resolved",
    // 1,000 chars: a full Indian address with a building name and a district runs
    // long, and truncating the line the client asked for is the wrong economy.
    displayName: text(body.display_name, 1_000),
    parts: {
      // `name` is Nominatim's own label for the feature — the venue or building.
      name: pick(body, "name") ??
        pick(address, "amenity", "building", "house_name", "shop", "office"),
      road: pick(address, "road", "pedestrian", "footway", "residential"),
      suburb: pick(address, "neighbourhood", "suburb", "quarter", "city_district"),
      city: pick(address, "city", "town", "village", "municipality", "county"),
      state: pick(address, "state", "state_district"),
      postcode: pick(address, "postcode"),
      country: pick(address, "country"),
    },
    providerPlaceId: placeId(body.place_id),
    raw: address,
    reason: null,
  };
}

/**
 * Google Geocoding, used only when `GOOGLE_MAPS_API_KEY` is set. Google returns
 * the address as an ARRAY of typed components rather than named fields, so the
 * mapping is by `types` — and `result_type`/`location_type` are left alone so the
 * most specific result (Google orders them that way) is the one taken.
 */
async function fromGoogle(lat: number, lng: number, apiKey: string): Promise<Lookup> {
  const url = new URL(GOOGLE_GEOCODE_URL);
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", apiKey);

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    return providerFailure(`Google Geocoding answered HTTP ${response.status}.`);
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (body === null) {
    return providerFailure("Google Geocoding's response could not be read as JSON.");
  }

  const status = typeof body.status === "string" ? body.status : "UNKNOWN";
  if (status === "ZERO_RESULTS") {
    return {
      outcome: "not_found",
      displayName: null,
      parts: EMPTY_PARTS,
      providerPlaceId: null,
      raw: {},
      reason: "Google has no address recorded at this coordinate.",
    };
  }
  if (status !== "OK") {
    // OVER_QUERY_LIMIT / REQUEST_DENIED / INVALID_REQUEST. The provider's own
    // `error_message` is operational detail, so it goes in the stored reason
    // rather than being swallowed — an admin debugging a blank address needs it.
    return providerFailure(`Google Geocoding status ${status}${
      typeof body.error_message === "string" ? `: ${body.error_message.slice(0, 200)}` : ""
    }.`);
  }

  const results = Array.isArray(body.results) ? body.results : [];
  const first = results[0];
  if (typeof first !== "object" || first === null) {
    return providerFailure("Google Geocoding returned OK with no usable result.");
  }
  const result = first as Record<string, unknown>;

  const components = Array.isArray(result.address_components) ? result.address_components : [];
  /** Long name of the first component carrying any of these Google types. */
  const byType = (...types: readonly string[]): string | null => {
    for (const wanted of types) {
      for (const entry of components) {
        if (typeof entry !== "object" || entry === null) continue;
        const component = entry as Record<string, unknown>;
        const componentTypes = Array.isArray(component.types) ? component.types : [];
        if (componentTypes.includes(wanted)) {
          const found = text(component.long_name);
          if (found !== null) return found;
        }
      }
    }
    return null;
  };
  return {
    outcome: "resolved",
    displayName: text(result.formatted_address, 1_000),
    parts: {
      // Google rarely returns a POI for a bare coordinate, so this is often null
      // while `road` and below are populated. That is the honest answer, not a
      // gap to fill with a guess: the display line still carries the full address.
      name: byType("point_of_interest", "establishment", "premise", "subpremise"),
      road: byType("route"),
      suburb: byType("sublocality_level_1", "sublocality", "neighborhood"),
      city: byType("locality", "postal_town", "administrative_area_level_2"),
      state: byType("administrative_area_level_1"),
      postcode: byType("postal_code"),
      country: byType("country"),
    },
    providerPlaceId: placeId(result.place_id),
    // Only the component list, never the whole envelope: no key, no geometry,
    // nothing that is not the address.
    raw: { address_components: components, formatted_address: text(result.formatted_address, 1_000) },
    reason: null,
  };
}

/** A provider that failed. Never cached as an address; cached briefly as an error. */
function providerFailure(reason: string): Lookup {
  return {
    outcome: "provider_error",
    displayName: null,
    parts: EMPTY_PARTS,
    providerPlaceId: null,
    raw: {},
    reason,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ─────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ───────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ─────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;

  try {
    assertOriginAllowed(req);
    const client = sqlHandle();

    // ── STEP 4 · Auth (model U) ───────────────────────────────────────────────
    const auth = await verifyUser(req);

    // ── STEP 5 · Authority, from the DATABASE ─────────────────────────────────
    await requireCapWithStepUp(client, auth, CAP_READ_PUNCH_DETAIL);

    // ── STEP 6 · Rate limit, per user ─────────────────────────────────────────
    // Before the body is parsed, so a caller cannot spend our provider budget by
    // sending garbage. The provider's OWN limit is a second, global bucket below.
    await enforce(
      RATE_LIMITS.reverseGeocode,
      limitKey(FN_NAME, auth.userId),
      "GEOCODE_RATE_LIMITED",
      client,
    );

    // ── STEP 7 · Validate ─────────────────────────────────────────────────────
    const { data: body } = await parseBody(req, Body, { maxBytes: 2 * 1024 });
    const { lat, lng } = body;
    // One normalisation, used by BOTH the lookup and the insert. See fixedSix().
    const latText = fixedSix(lat);
    const lngText = fixedSix(lng);

    // ── STEP 8 · Cache first ──────────────────────────────────────────────────
    // ONE statement that both finds the row and records the hit, so a hit costs a
    // single round-trip. `util.geocode_key(...::numeric(9,6))` is character-for-
    // character what migration 075's generated key columns compute, which is why
    // any coordinate inside the ~11 m square finds this row rather than nearly
    // finding it. Expired negative rows are skipped, so they read as a miss.
    const hitRows = await client`
      UPDATE public.geocode_cache g
         SET hit_count   = g.hit_count + 1,
             last_hit_at = now()
       WHERE g.lat_key = util.geocode_key(${latText}::numeric(9,6))
         AND g.lng_key = util.geocode_key(${lngText}::numeric(9,6))
         AND (g.expires_at IS NULL OR g.expires_at > now())
      RETURNING g.outcome,
                g.display_name,
                g.place_name,
                g.road,
                g.suburb,
                g.city,
                g.state,
                g.postcode,
                g.country,
                g.provider,
                g.failure_reason,
                g.fetched_at,
                g.lat_key::text AS lat_key,
                g.lng_key::text AS lng_key,
                g.hit_count
    `;
    const hit = firstRow(hitRows as unknown as CacheRow[]);

    if (hit !== null) {
      const outcome: Outcome = isOutcome(hit.outcome) ? hit.outcome : "provider_error";
      const responseBody = {
        lat,
        lng,
        key: { lat: hit.lat_key, lng: hit.lng_key },
        displayName: hit.display_name,
        parts: {
          name: hit.place_name,
          road: hit.road,
          suburb: hit.suburb,
          city: hit.city,
          state: hit.state,
          postcode: hit.postcode,
          country: hit.country,
        } satisfies AddressParts,
        cached: true,
        provider: isProvider(hit.provider) ? hit.provider : null,
        outcome,
        // `failure_reason` is stored only for `provider_error` (migration 075's
        // CHECK ties the two together), so a cached `not_found` needs its sentence
        // supplied here rather than coming back with nothing to show a reader.
        reason: hit.failure_reason ??
          (outcome === "not_found" ? "No address is recorded at this coordinate." : null),
        fetchedAt: toIso(hit.fetched_at),
        requestId,
      };
      status = 200;
      log.info("cache hit", { outcome, hit_count: hit.hit_count, provider: hit.provider });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── STEP 9 · Miss: choose a provider ──────────────────────────────────────
    // Google when a key is configured (the client referred to Google's detail
    // quality), Nominatim otherwise. The key is read here and never returned,
    // logged or handed to a client.
    const googleKey = (Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "").trim();
    const provider: Provider = googleKey === "" ? "nominatim" : "google";

    let lookup: Lookup;
    if (provider === "nominatim") {
      // The 1 request/second policy ceiling, shared by every isolate. One short
      // wait and one retry: a second admin opening a second new gate gets served
      // rather than refused, and the ceiling still holds because the token — not
      // the sleep — is the permission.
      let token = await tryTake(RATE_LIMITS.nominatim, limitKey("nominatim"), client);
      if (!token) {
        await sleep(NOMINATIM_TOKEN_WAIT_MS);
        token = await tryTake(RATE_LIMITS.nominatim, limitKey("nominatim"), client);
      }
      if (!token) {
        // Deliberately NOT cached: we never reached the provider, so there is
        // nothing to remember, and caching this would make our own throttle look
        // like a place with no address. The caller retries on the next render.
        const responseBody = {
          lat,
          lng,
          key: null,
          displayName: null,
          parts: EMPTY_PARTS,
          cached: false,
          provider,
          outcome: "provider_throttled" satisfies Outcome,
          reason:
            "Too many places are being looked up at once. This one will resolve on the next attempt.",
          fetchedAt: null,
          requestId,
        };
        status = 200;
        log.warn("nominatim 1/s ceiling reached, degrading", { provider });
        return ok(responseBody, { status, headers: cors, requestId });
      }

      lookup = await fromNominatim(lat, lng).catch((err: unknown) =>
        // A timeout or a DNS failure is a provider failure, not a 500 of ours.
        providerFailure(`Nominatim could not be reached (${String(err).slice(0, 200)}).`)
      );
    } else {
      lookup = await fromGoogle(lat, lng, googleKey).catch((err: unknown) =>
        providerFailure(`Google Geocoding could not be reached (${String(err).slice(0, 200)}).`)
      );
    }

    // A "resolved" answer with no line to show is not resolved. Downgrading here
    // rather than storing it keeps migration 075's shape CHECK from rejecting the
    // write, and keeps the client from rendering an empty address.
    if (lookup.outcome === "resolved" && lookup.displayName === null) {
      lookup = providerFailure("The geocoder returned a result with no address line.");
    }

    /*
      ── STEP 10 · Store, then answer ──────────────────────────────────────────

      ONE SPELLING IN HERE IS LOAD-BEARING: `::text::jsonb`, NOT `::jsonb`.

      In `$n::jsonb`, Postgres resolves the parameter's own type to jsonb and says
      so in its ParameterDescription. postgres.js then applies its jsonb
      serializer, which is `JSON.stringify` — so a value that is ALREADY a JSON
      string gets encoded a second time, and the column ends up holding the jsonb
      SCALAR STRING "{\"road\":\"…\"}" instead of an object. `jsonb_typeof` says
      `string`, every `->>` returns NULL, and nothing errors: the row looks stored
      and is unusable.

      `$n::text::jsonb` types the parameter as text (identity serialisation) and
      lets POSTGRES do the parse. Verified against this database before this line
      was written:
        jsonb_typeof($1::jsonb)       -> string   (wrong)
        jsonb_typeof($1::text::jsonb) -> object   (right)

      The plain `::jsonb` form appears in ~15 other functions in this repo and has
      the same defect there; fixing those is a separate, deliberate change with its
      own data backfill, not a drive-by edit from here.
    */
    // Upsert on the rounded key. `ON CONFLICT` is reached whenever a concurrent
    // request filled the same square between the read above and here, or when an
    // expired negative row is being replaced — both are normal, neither is an
    // error. The stored `lat`/`lng` are NOT overwritten: the square is the
    // identity, and the first fix that created it is kept as provenance.
    const ttlMinutes = lookup.outcome === "resolved"
      ? null
      : lookup.outcome === "not_found"
        ? NOT_FOUND_TTL_MINUTES
        : ERROR_TTL_MINUTES;

    /*
      `ck_geocode_cache__failure_reason` ties failure_reason to `provider_error`
      ALONE: the column must be NULL for anything else, because `not_found` IS its
      own explanation and a stored sentence would be prose duplicating an enum.
      Sending the not-found sentence here violated that CHECK and turned a perfectly
      good "no address at this coordinate" into a 500 — found by pointing this
      function at the middle of the Atlantic, which is the only way that path runs.

      The sentence still reaches the caller in `reason` below, and the cache-hit
      branch re-derives it for a stored `not_found`, so nothing is lost to a reader.
    */
    const storedFailureReason = lookup.outcome === "provider_error" ? lookup.reason : null;

    /*
      THE STORE IS BEST-EFFORT, AND THAT IS THE SAME PRINCIPLE AS THE HEADER'S.

      By this point the address is already in hand. If writing it to the cache
      fails — a constraint the writer has not learned about, a full disk, a
      connection lost — then the honest degradation is "this answer was not cached",
      NOT "the punch log cannot show where this punch happened". The very first run
      of the not-found path proved the cost of getting this wrong: one CHECK the
      writer disagreed with turned a correct geocode into a 500.

      It is not swallowed. `log.error` marks the line for the Sentry drain, and the
      response carries `cached: false` with no key, so a repeat of the same
      coordinate re-asks the provider and the failure keeps announcing itself.
    */
    // `readonly`: postgres.js hands back a frozen result array, not a plain one.
    let storedRows: readonly unknown[] = [];
    try {
      storedRows = await client`
      INSERT INTO public.geocode_cache (
        lat, lng, outcome, display_name, place_name, road, suburb, city, state,
        postcode, country, provider_raw, provider, provider_place_id,
        failure_reason, fetched_at, expires_at
      )
      VALUES (
        ${latText}::numeric(9,6),
        ${lngText}::numeric(9,6),
        ${lookup.outcome},
        ${lookup.displayName},
        ${lookup.parts.name},
        ${lookup.parts.road},
        ${lookup.parts.suburb},
        ${lookup.parts.city},
        ${lookup.parts.state},
        ${lookup.parts.postcode},
        ${lookup.parts.country},
        ${JSON.stringify(lookup.raw)}::text::jsonb,
        ${provider},
        ${lookup.providerPlaceId},
        ${storedFailureReason},
        now(),
        now() + ${ttlMinutes}::integer * INTERVAL '1 minute'
      )
      ON CONFLICT ON CONSTRAINT uq_geocode_cache__key DO UPDATE
         SET outcome           = EXCLUDED.outcome,
             display_name      = EXCLUDED.display_name,
             place_name        = EXCLUDED.place_name,
             road              = EXCLUDED.road,
             suburb            = EXCLUDED.suburb,
             city              = EXCLUDED.city,
             state             = EXCLUDED.state,
             postcode          = EXCLUDED.postcode,
             country           = EXCLUDED.country,
             provider_raw      = EXCLUDED.provider_raw,
             provider          = EXCLUDED.provider,
             provider_place_id = EXCLUDED.provider_place_id,
             failure_reason    = EXCLUDED.failure_reason,
             fetched_at        = EXCLUDED.fetched_at,
             expires_at        = EXCLUDED.expires_at
      RETURNING fetched_at,
                lat_key::text AS lat_key,
                lng_key::text AS lng_key
    `;
    } catch (storeErr) {
      log.error("could not cache the geocode result", {
        err: storeErr,
        provider,
        outcome: lookup.outcome,
      });
    }
    const stored = firstRow(
      storedRows as unknown as { fetched_at: Date | string; lat_key: string; lng_key: string }[],
    );

    const responseBody = {
      lat,
      lng,
      key: stored === null ? null : { lat: stored.lat_key, lng: stored.lng_key },
      displayName: lookup.displayName,
      parts: lookup.parts,
      cached: false,
      provider,
      outcome: lookup.outcome,
      reason: lookup.reason,
      // The instant the ANSWER was obtained, which is now on this path. When the
      // cache write succeeded that is the row's own fetched_at; when it did not,
      // `nowIso()` is still the truth about the answer being returned. Never
      // `new Date()` — `_shared/datetime.ts` is the only clock in this codebase.
      fetchedAt: stored === null ? nowIso() : toIso(stored.fetched_at),
      requestId,
    };
    status = 200;

    if (lookup.outcome === "resolved") {
      log.info("geocoded and cached", { provider, key: responseBody.key });
    } else {
      // Visible as a warning, invisible as a page failure. See the file header.
      log.warn("provider gave no address, negative-cached", {
        provider,
        outcome: lookup.outcome,
        reason: lookup.reason,
        ttl_minutes: ttlMinutes,
      });
    }

    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;
    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ──────────────────────
    log.finish(status);
  }
});

/** Exported for `supabase/tests` — the function and the tests share one schema. */
export { Body, CAP_READ_PUNCH_DETAIL, ERROR_TTL_MINUTES, NOT_FOUND_TTL_MINUTES };
