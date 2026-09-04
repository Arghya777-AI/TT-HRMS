/**
 * JourneyMap — the day's location points, in order, on an OpenStreetMap.
 *
 * ── THE ONE THING THIS COMPONENT MUST NOT DO ─────────────────────────────────
 * Make a scribble look like a journey.
 *
 * Read a real day from this venue: ten points between 13:28 and 16:40, each 16 to 60 m
 * from the gate, every one of them accurate to no better than ±35 m. Joined with a line
 * that reads as somebody walking a route. They are not: the whole spread is inside the
 * error of each individual reading. Two consecutive fixes 30 m apart, each ±35 m, are
 * consistent with a person who never moved at all.
 *
 * So every point is drawn WITH ITS ACCURACY CIRCLE, always, at the same map scale as the
 * line. When the circles swallow the path — which at this venue is most days — an
 * administrator can see that for themselves instead of being told a story by a polyline.
 * Hiding the circles would make a prettier map and a dishonest one, and this screen exists
 * to decide whether somebody was where they said they were.
 *
 * The other two properties carried over from the list view, for the same reason:
 *   · A GAP IS A CLOSED APP, not an absent person. The line therefore renders DASHED
 *     between points more than fifteen minutes apart, so a straight hour-long leap cannot
 *     be mistaken for a straight hour-long walk. Nobody knows what happened in between.
 *   · A fix coarser than COARSE_ABOVE_M places nobody, so it is drawn hollow and left out
 *     of the path rather than silently plotted.
 *
 * ── WHY LEAFLET IS LOADED ON DEMAND ──────────────────────────────────────────
 * The library and its stylesheet are ~150 KB and this panel sits behind a day's expander
 * on one admin screen. A static import would put it in the shell chunk that every
 * employee downloads to look at their own payslip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type * as L from "leaflet";
import { fmtTime } from "@/lib/datetime";
import { formatDistance, type VenuePoint } from "@/lib/venueDistance";
import { roundAccuracy } from "@/lib/punchPlace";
import { t } from "@/shared/i18n/en";
import type { LocationPing } from "../api/locationTrail.api";
import { pathRuns, spreadIsWithinError, toFixes } from "../journeyPath";

/** Tiles are OpenStreetMap's, and their licence requires the credit rendered on the map. */
const TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface JourneyMapProps {
  readonly pings: readonly LocationPing[];
  readonly venue: VenuePoint | null;
}

export function JourneyMap({ pings, venue }: JourneyMapProps): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const [failed, setFailed] = useState(false);

  /*
    Is this route actually a route? Computed, stated in words, and not left for the reader
    to infer from overlapping circles. When the whole day's spread fits inside the error of
    a single reading, the honest sentence is "this may not be movement at all" — and it
    goes above the map, where somebody deciding whether an employee left the site will
    read it before they read the line.
  */
  const noise = useMemo(() => spreadIsWithinError(toFixes(pings)), [pings]);

  useEffect(() => {
    let cancelled = false;
    let created: L.Map | null = null;

    void (async () => {
      try {
        // Both on demand; the CSS is what makes tiles and panes lay out at all.
        const [leaflet] = await Promise.all([
          import("leaflet"),
          import("leaflet/dist/leaflet.css"),
        ]);
        if (cancelled || host.current === null) return;

        const fixes = toFixes(pings);
        const runs = pathRuns(fixes);

        created = leaflet.map(host.current, {
          // A journey is read by panning, not by spinning a globe.
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: false, // the page scrolls past this panel; the map must not eat it
        });
        map.current = created;
        /*
          A non-null local. `created` is `Map | null` for the cleanup path, and TypeScript
          cannot keep that narrowing inside the marker callback below — capturing it once is
          honest about the lifetime instead of asserting non-null at each of six call sites.
        */
        const m = created;
        leaflet.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m);

        const bounds = leaflet.latLngBounds([]);

        // ── The venue and its geofence, so "20 m away" has something to be away from ──
        if (venue !== null) {
          const at = leaflet.latLng(venue.lat, venue.lng);
          leaflet.circle(at, {
            radius: venue.radiusM,
            color: "#6E8B45", weight: 1, fillColor: "#6E8B45", fillOpacity: 0.06,
            interactive: false,
          }).addTo(m);
          leaflet.circleMarker(at, {
            radius: 5, color: "#2E5E33", weight: 2, fillColor: "#2E5E33", fillOpacity: 1,
          }).addTo(m).bindPopup(
            `<b>${venue.name}</b><br>${t("admin.journey.venueFence", {
              m: String(venue.radiusM),
            })}`,
          );
          bounds.extend(at);
        }

        // ── Accuracy circles FIRST, under everything, at true map scale ──────────
        for (const f of fixes) {
          if (f.accuracy === null) continue;
          leaflet.circle([f.lat, f.lng], {
            radius: f.accuracy,
            color: "#B3A796", weight: 1, opacity: 0.5,
            fillColor: "#B3A796", fillOpacity: 0.1,
            interactive: false,
          }).addTo(m);
        }

        // ── The path: solid within a run, dashed across a gap ────────────────────
        for (const run of runs) {
          if (run.length < 2) continue;
          leaflet.polyline(run.map((f) => [f.lat, f.lng] as [number, number]), {
            color: "#2E5E33", weight: 3, opacity: 0.85,
          }).addTo(m);
        }
        for (let i = 1; i < runs.length; i += 1) {
          const from = runs[i - 1]?.at(-1);
          const to = runs[i]?.[0];
          if (from === undefined || to === undefined) continue;
          leaflet.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
            color: "#2E5E33", weight: 2, opacity: 0.45, dashArray: "4 7",
          }).addTo(m).bindPopup(t("admin.journey.gap", {
            from: fmtTime(from.at), to: fmtTime(to.at),
          }));
        }

        // ── The points themselves, numbered in the order they were taken ─────────
        fixes.forEach((f, i) => {
          const first = i === 0;
          const last = i === fixes.length - 1;
          const marker = leaflet.circleMarker([f.lat, f.lng], {
            radius: first || last ? 8 : 6,
            weight: 2,
            color: f.coarse ? "#B3A796" : "#1F3D22",
            // Hollow when the fix cannot place anybody; the ends of the day stand out.
            fillColor: f.coarse ? "#FFFFFF" : first ? "#A9C46B" : last ? "#C9A94F" : "#2E5E33",
            fillOpacity: f.coarse ? 0.25 : 1,
          }).addTo(m);
          const bits = [
            `<b>${fmtTime(f.at)} IST</b> &middot; ${t("admin.journey.pointOf", {
              n: String(i + 1), total: String(fixes.length),
            })}`,
            f.distance === null ? null : t("admin.trail.fromVenue", { d: formatDistance(f.distance) }),
            f.accuracy === null
              ? t("admin.journey.noAccuracy")
              : t(f.coarse ? "admin.trail.coarse" : "admin.trail.accuracy", {
                m: String(roundAccuracy(f.accuracy)),
              }),
            f.offline ? t("admin.trail.replayed") : null,
          ].filter((b): b is string => b !== null);
          marker.bindPopup(bits.join("<br>"));
          bounds.extend([f.lat, f.lng]);
        });

        /*
          Fit to the points AND their error, so the frame never implies more precision than
          the data has. A single fix would otherwise zoom to street level on a ±35 m reading.
        */
        const widest = fixes.reduce((m, f) => Math.max(m, f.accuracy ?? 0), 0);
        if (bounds.isValid()) {
          m.fitBounds(bounds.pad(0.18), { maxZoom: widest > 100 ? 15 : 17 });
        } else {
          m.setView([12.8643, 77.5633], 15); // nothing plottable: hold at the venue
        }
      } catch {
        // A blocked CDN, a dead tile host, a browser refusing WebGL-less canvas: the list
        // below is the record and still reads fine. Never take the panel down with the map.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      created?.remove();
      map.current = null;
    };
  }, [pings, venue]);

  if (failed) {
    return (
      <p className="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {t("admin.journey.failed")}
      </p>
    );
  }

  return (
    <figure className="mt-3 mb-0">
      {noise ? (
        <p className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          {t("admin.journey.withinError")}
        </p>
      ) : null}
      <div
        ref={host}
        role="img"
        aria-label={t("admin.journey.alt", { n: String(pings.length) })}
        className="h-[340px] w-full overflow-hidden rounded-lg border bg-muted"
      />
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full" style={{ background: "#A9C46B" }} />
          {t("admin.journey.key.first")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full" style={{ background: "#C9A94F" }} />
          {t("admin.journey.key.last")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: "#2E5E33" }} />
          {t("admin.journey.key.gap")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-full border"
            style={{ borderColor: "#B3A796", background: "rgba(179,167,150,.25)" }}
          />
          {t("admin.journey.key.accuracy")}
        </span>
      </figcaption>
    </figure>
  );
}
