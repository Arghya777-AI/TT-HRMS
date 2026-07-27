/**
 * geolocation.ts — the sign-in location, asked for once, never insisted upon.
 *
 * WHY IT EXISTS: `public.sessions_audit.geo` is a `jsonb` column (migration
 * 20260801000400_identity_core.sql §5) that the security console reads next to
 * the IP, user agent and auth method. Coordinates make "signed in from
 * Bengaluru at 07:12" answerable; without them a suspicious session is just an
 * IP address.
 *
 * THREE RULES, all of them load-bearing:
 *   1. A refusal is not a failure. `getCurrentPosition` errors — denied,
 *      unavailable, timed out — resolve to `{ status, geo: null }`. This module
 *      never rejects, so no caller can accidentally turn "I don't want to share
 *      my location" into "you cannot sign in".
 *   2. The reason is on screen BEFORE the browser prompt. The caller renders the
 *      explanation and then calls this; the native permission dialog lands on
 *      top of an explanation the user has already read.
 *   3. Coordinates are captured, shown, and passed to the one edge function
 *      whose contract accepts them. They are never written to storage here.
 *
 * The shape below mirrors the punch convention in spec-employee §E-10
 * (`geo_lat/geo_lng/accuracy`) with an IST-safe capture instant from
 * `src/lib/datetime.ts` — `new Date().toISOString()` is banned repo-wide.
 */
import { nowInstantIso } from "@/lib/datetime";

/** What lands in `sessions_audit.geo`. */
export interface SignInGeo {
  lat: number;
  lon: number;
  /** Browser-reported accuracy radius in metres, rounded. */
  accuracy_m: number;
  /** ISO-8601 instant, IST-offset, from `nowInstantIso()`. */
  captured_at: string;
  source: "browser";
}

export type SignInLocationStatus =
  /** Not asked yet. */
  | "idle"
  /** Prompt is open / the fix is being taken. */
  | "asking"
  /** Coordinates in hand. */
  | "granted"
  /** The user said no — an expected, supported outcome. */
  | "denied"
  /** No `navigator.geolocation`, or an insecure context. */
  | "unavailable"
  /** Position unavailable or timed out. */
  | "error";

export interface SignInLocationOutcome {
  status: SignInLocationStatus;
  geo: SignInGeo | null;
}

/**
 * What a punch endpoint accepts. `attendance-self-punch` and `kiosk-punch` share
 * this shape (`_shared/geofence.ts` → `PunchGeo`) and both treat it as optional.
 */
export interface PunchGeoWire {
  latitude: number;
  longitude: number;
  accuracyMetres?: number;
}

/**
 * `SignInGeo` → the punch wire shape.
 *
 * Lives here rather than in one caller because BOTH punch paths need it: the
 * employee's portal and the guard's kiosk. The kiosk sent no location at all until
 * this was shared, so a gate punch could not answer "where" while a web punch
 * could.
 */
export function toPunchGeo(geo: SignInGeo): PunchGeoWire {
  return {
    latitude: geo.lat,
    longitude: geo.lon,
    // `accuracy_m` is 0 when the browser reported no finite accuracy. Sending 0
    // would assert a fix accurate to the metre and would write that 0 into
    // `attendance_punches.location_accuracy_m` — an invented precision. Omitted
    // instead, which the function reads as "not known" and treats identically for
    // `accuracyTooCoarse`.
    ...(geo.accuracy_m > 0 ? { accuracyMetres: geo.accuracy_m } : {}),
  };
}

/** Long enough for a cold GPS fix on a phone, short enough not to stall sign-in. */
const TIMEOUT_MS = 8_000;
/** A minute-old fix is fine for "which building was this" and saves a cold start. */
const MAX_AGE_MS = 60_000;

/** True when this browser can be asked at all. Geolocation needs a secure context. */
export function supportsGeolocation(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator && window.isSecureContext;
}

/**
 * Read the permission WITHOUT prompting, when the Permissions API is available.
 * Used to label the notice honestly ("already refused") instead of firing a
 * prompt the browser will silently swallow.
 */
export async function readGeolocationPermission(): Promise<PermissionState | null> {
  if (typeof navigator === "undefined" || navigator.permissions === undefined) return null;
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state;
  } catch {
    // Firefox historically threw on unknown names. Not knowing is fine.
    return null;
  }
}

/**
 * Ask for the sign-in location. Resolves — always — with an outcome the UI can
 * render. `enableHighAccuracy` is deliberately false: this records which
 * building someone signed in from, not a survey point, and the low-power fix
 * arrives in a second instead of ten.
 */
export function requestSignInLocation(): Promise<SignInLocationOutcome> {
  if (!supportsGeolocation()) {
    return Promise.resolve({ status: "unavailable", geo: null });
  }
  return new Promise<SignInLocationOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SignInLocationOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          finish({ status: "error", geo: null });
          return;
        }
        finish({
          status: "granted",
          geo: {
            // Six decimals ≈ 0.1 m. More than that is noise the audit cannot use.
            lat: Number(latitude.toFixed(6)),
            lon: Number(longitude.toFixed(6)),
            accuracy_m: Number.isFinite(accuracy) ? Math.round(accuracy) : 0,
            captured_at: nowInstantIso(),
            source: "browser",
          },
        });
      },
      (err) => {
        finish({
          status: err.code === err.PERMISSION_DENIED ? "denied" : "error",
          geo: null,
        });
      },
      { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    );
  });
}
