/**
 * locationTrail.api.ts — where somebody's device reported being, during one day.
 *
 * ── WHAT THIS IS, AND WHAT A GAP IN IT MEANS ─────────────────────────────────
 * The venue holds signed consent to track staff location. `employee_location_pings` holds a
 * sample every five minutes WHILE THE APP IS OPEN — which is the ceiling for a web
 * application: `watchPosition` is suspended when the page is hidden and the Geolocation API is
 * not exposed to service workers at all.
 *
 * So A GAP MEANS THE APP WAS CLOSED. It does not mean the employee was elsewhere, and the
 * screen reading this must say so rather than let an absence of dots be read as an absence of
 * person. That is the single most important property of this whole feature: a trail presented
 * as continuous when it is not would be used to accuse somebody.
 *
 * ── NO PERMISSION LOGIC HERE ─────────────────────────────────────────────────
 * `elp__admin_select` admits an administrator within scope and `elp__self_select` admits the
 * employee to their own. Both run under the caller's token, so this module filters by day and
 * nothing else — RLS decides whose day it may be.
 */
import { z } from "zod";
import { dbDate, dbNumericNullable, dbTimestamp, dbUuid, eq, selectMany } from "@/shared/api/query";

export const LOCATION_PINGS_TABLE = "employee_location_pings";

/**
 * A day's worth of samples is small by design — the client throttles to five minutes AND fifty
 * metres of movement — so 400 is far above a real day and still a bound.
 */
export const TRAIL_ROW_CAP = 400;

export const locationPingSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  captured_at: dbTimestamp,
  ist_date: dbDate,
  lat: dbNumericNullable,
  lng: dbNumericNullable,
  /**
   * The browser's accuracy radius, in metres.
   *
   * SHOWN BESIDE EVERY POINT, never hidden. A fix good to 2 km and one good to 8 m look
   * identical on a map and mean completely different things; a reader deciding whether somebody
   * was where they said needs to know which one they are looking at.
   */
  accuracy_m: dbNumericNullable,
  /** 'web_foreground' today. 'native_background' is reserved and unused — no native app exists. */
  source: z.string(),
  /** The server's answer at capture time, not re-derived from a shift that may have changed. */
  within_shift: z.boolean().nullable(),
  distance_m: dbNumericNullable,
});
export type LocationPing = z.infer<typeof locationPingSchema>;

const PING_COLUMNS =
  "id, employee_id, captured_at, ist_date, lat, lng, accuracy_m, source, " +
  "within_shift, distance_m";

/**
 * One employee's samples for one IST day, oldest first.
 *
 * Ascending on purpose: a trail is read as a journey, and newest-first would show somebody
 * arriving at the end.
 */
export function fetchLocationTrail(
  employeeId: string,
  istDate: string,
  signal?: AbortSignal,
): Promise<LocationPing[]> {
  return selectMany(LOCATION_PINGS_TABLE, locationPingSchema, {
    columns: PING_COLUMNS,
    filters: [eq("employee_id", employeeId), eq("ist_date", istDate)],
    order: [{ column: "captured_at", ascending: true }],
    limit: TRAIL_ROW_CAP,
    ...(signal ? { signal } : {}),
  });
}

/**
 * What a day's trail adds up to.
 *
 * `furthestMetres` is the figure an administrator actually asked for — "I just want to make
 * sure that he is there only" — and it is the MAXIMUM rather than an average, because an
 * average over a day spent mostly at the venue would hide the hour spent somewhere else.
 */
export interface TrailSummary {
  readonly points: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly furthestMetres: number | null;
  /** Points taken outside the shift window, by the server's own answer at capture time. */
  readonly outsideShift: number;
  /** Points too coarse to place anybody — kept, counted, and never silently dropped. */
  readonly coarse: number;
}

/** Metres beyond which a fix cannot place somebody. Mirrors the client's own ceiling. */
export const COARSE_ABOVE_M = 2_000;

export function summariseTrail(pings: readonly LocationPing[]): TrailSummary {
  if (pings.length === 0) {
    return { points: 0, firstAt: null, lastAt: null, furthestMetres: null, outsideShift: 0, coarse: 0 };
  }
  let furthest: number | null = null;
  let outsideShift = 0;
  let coarse = 0;
  for (const p of pings) {
    const d = p.distance_m === null ? null : Number(p.distance_m);
    if (d !== null && Number.isFinite(d) && (furthest === null || d > furthest)) furthest = d;
    if (p.within_shift === false) outsideShift += 1;
    const acc = p.accuracy_m === null ? null : Number(p.accuracy_m);
    if (acc !== null && Number.isFinite(acc) && acc > COARSE_ABOVE_M) coarse += 1;
  }
  return {
    points: pings.length,
    firstAt: pings[0]?.captured_at ?? null,
    lastAt: pings[pings.length - 1]?.captured_at ?? null,
    furthestMetres: furthest,
    outsideShift,
    coarse,
  };
}
