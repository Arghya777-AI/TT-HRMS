/**
 * LocationTrailPanel — where somebody's device reported being, during one day.
 *
 * ── THE ONE THING THIS SCREEN MUST NOT LET ANYONE CONCLUDE ───────────────────
 * That a gap means the person was not there.
 *
 * `employee_location_pings` holds a sample every five minutes WHILE THE APP IS OPEN, which is
 * the ceiling for a web application: `watchPosition` is suspended the moment the page is hidden,
 * and the Geolocation API is not available to service workers at all. There is no native app in
 * this product to do better — the shell's whole bridge is `playSound` and `speak`.
 *
 * So an empty trail means the app was closed. It is not evidence of absence, and this panel says
 * that in words, every time, ABOVE the points rather than in a footnote — because the figure an
 * administrator came here for ("I just want to make sure that he is there only") is exactly the
 * figure somebody could otherwise use to accuse a person who had simply shut their phone.
 *
 * ── ACCURACY IS SHOWN BESIDE EVERY POINT ─────────────────────────────────────
 * A fix good to 8 metres and one good to 2 kilometres look identical on a map. The second cannot
 * place anybody, and is marked as such rather than quietly rendered as a location.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapIcon, MapPin, Navigation, WifiOff } from "lucide-react";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "./Notice";
import { fmtTime } from "@/lib/datetime";
import { formatDistance } from "@/lib/venueDistance";
import { formatCoordinates, openStreetMapUrl, roundAccuracy } from "@/lib/punchPlace";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { useQuery as useVenueQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  COARSE_ABOVE_M,
  fetchLocationTrail,
  fetchVenuePoint,
  summariseTrail,
  type LocationPing,
} from "../api/locationTrail.api";

/*
  Leaflet and its stylesheet are ~150 KB, and this panel sits behind a day's expander on one
  admin screen. Static, it would land in the chunk every employee downloads to read a payslip.
*/
const JourneyMap = lazy(() =>
  import("./JourneyMap").then((m) => ({ default: m.JourneyMap })),
);

export interface LocationTrailPanelProps {
  readonly employeeId: string;
  readonly istDate: string;
}

/** `numeric` arrives as a string; `Number(null)` is 0, which is a real coordinate. */
function num(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function PingRow({ ping }: { ping: LocationPing }) {
  const lat = num(ping.lat);
  const lng = num(ping.lng);
  const accuracy = num(ping.accuracy_m);
  const distance = num(ping.distance_m);
  const tooCoarse = accuracy !== null && accuracy > COARSE_ABOVE_M;
  const fix = lat !== null && lng !== null ? { latitude: lat, longitude: lng, accuracyMetres: accuracy } : null;

  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-1.5 last:border-b-0">
      {/*
        `fmtTime`, not `fmtDateTime(...).slice(-5)`. That slice was written to take the
        trailing "HH:MM" off the full instant, but `fmtDateTime` renders
        "25-Jul-2026 09:05 IST" — so the last five characters are "5 IST", and every point
        on this panel displayed a single digit of the minute followed by the timezone.
        Reported as "what is this timing?", which is the only sane reaction to "3 IST".
      */}
      <span className="num w-16 shrink-0 text-sm tabular-nums">
        {fmtTime(ping.captured_at)}
      </span>

      {fix === null ? (
        <span className="text-xs text-muted-foreground">{t("admin.trail.noFix")}</span>
      ) : (
        <a
          href={openStreetMapUrl(fix)}
          target="_blank"
          rel="noopener noreferrer"
          className="num inline-flex items-center gap-1 text-xs underline decoration-dotted"
        >
          <MapPin className="size-3 shrink-0" aria-hidden />
          {formatCoordinates(fix)}
        </a>
      )}

      {distance !== null ? (
        <span className="num text-xs text-muted-foreground">
          {t("admin.trail.fromVenue", { d: formatDistance(distance) })}
        </span>
      ) : null}

      {/*
        Accuracy, always. A 2 km fix is not a location, and marking it is the difference
        between a trail and a set of dots somebody will over-read.
      */}
      {accuracy !== null ? (
        <span className={cn("num text-xs", tooCoarse ? "text-warning" : "text-muted-foreground")}>
          {tooCoarse
            ? t("admin.trail.coarse", { m: String(roundAccuracy(accuracy)) })
            : t("admin.trail.accuracy", { m: String(roundAccuracy(accuracy)) })}
        </span>
      ) : null}

      {ping.within_shift === false ? (
        <span className="text-xs text-muted-foreground">{t("admin.trail.offShift")}</span>
      ) : null}

      {/*
        Marked, because it changes what the point means. The fix is just as accurate — GPS needs
        no network — but it was replayed out of a dead zone, so nobody could have been watching
        the trail at the time. That is the difference between a record and a live signal.
      */}
      {ping.captured_offline ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <WifiOff className="size-3 shrink-0" aria-hidden />
          {t("admin.trail.replayed")}
        </span>
      ) : null}
    </li>
  );
}

export function LocationTrailPanel({ employeeId, istDate }: LocationTrailPanelProps) {
  const trail = useQuery({
    queryKey: qk.admin.list({ part: "location-trail", employeeId, istDate }),
    queryFn: ({ signal }) => fetchLocationTrail(employeeId, istDate, signal),
    retry: shouldRetryQuery,
  });
  const pings = trail.data ?? [];
  const summary = useMemo(() => summariseTrail(pings), [pings]);

  /*
    The map is opt-in. Two reasons, and the second is the one that matters: it costs a
    library and a dozen tile requests, and a route drawn between points is the most
    over-readable thing on this screen. Somebody who wants it asks for it, having already
    seen the caveat and the accuracy of each reading in the list.
  */
  const [showMap, setShowMap] = useState(false);
  const venue = useVenueQuery({
    queryKey: qk.admin.list({ part: "venue-point" }),
    queryFn: ({ signal }) => fetchVenuePoint(signal),
    retry: shouldRetryQuery,
    enabled: showMap,
    staleTime: 30 * 60 * 1000, // a venue does not move
  });

  /** Two points is the fewest that can make a line. One point is not a journey. */
  const canDrawRoute = pings.filter((p) => p.lat !== null && p.lng !== null).length >= 2;

  return (
    <section className="mt-4 border-t pt-4" aria-label={t("admin.trail.title")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("admin.trail.title")}</h3>
        {summary.points > 0 ? (
          <p className="num text-xs text-muted-foreground">
            {t("admin.trail.count", { n: String(summary.points) })}
            {summary.furthestMetres !== null
              ? ` · ${t("admin.trail.furthest", { d: formatDistance(summary.furthestMetres) })}`
              : ""}
          </p>
        ) : null}
      </div>

      {/*
        ── THE CAVEAT, ABOVE THE DATA AND NOT BELOW IT ─────────────────────────
        Stated every time, whether the trail is full or empty. Somebody scanning this panel to
        decide whether an employee was where they claimed will read the first sentence and the
        dots; if the limitation is a footnote they will not read it at all.
      */}
      <div className="mt-2">
        <Notice tone="info">{t("admin.trail.caveat")}</Notice>
      </div>

      <StateBoundary
        loading={trail.isPending}
        error={trail.error}
        onRetry={() => void trail.refetch()}
      >
        {summary.points === 0 ? (
          <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
            <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("admin.trail.empty")}
          </p>
        ) : (
          <>
            <p className="mt-3 flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
              {/*
                Rendered only when both ends exist, rather than passed through `?? ""` to
                satisfy the type. An empty string reaches `new Date("")`, which is an Invalid
                Date, and the window would have read "NaN:NaN" — the same class of mistake as
                the slice this replaced, where a formatting shortcut produced confident
                nonsense instead of nothing.
              */}
              {summary.firstAt !== null && summary.lastAt !== null ? (
                <span className="inline-flex items-center gap-1">
                  <Navigation className="size-3" aria-hidden />
                  {t("admin.trail.window", {
                    from: fmtTime(summary.firstAt),
                    to: fmtTime(summary.lastAt),
                  })}
                </span>
              ) : null}
              {summary.outsideShift > 0 ? (
                <span>{t("admin.trail.outsideShift", { n: String(summary.outsideShift) })}</span>
              ) : null}
              {/*
                Counted and surfaced rather than filtered away: an administrator reading
                "14 points" deserves to know that three of them could not place anybody.
              */}
              {summary.coarse > 0 ? (
                <span className="text-warning">
                  {t("admin.trail.coarseCount", { n: String(summary.coarse) })}
                </span>
              ) : null}
              {summary.replayed > 0 ? (
                <span>{t("admin.trail.replayedCount", { n: String(summary.replayed) })}</span>
              ) : null}
            </p>

            {/*
              ── THE ROUTE, ON REQUEST ───────────────────────────────────────
              Below the summary and above the points, so the accuracy of each reading is
              read before the line that joins them. Offered only when there are two points
              to join: one point is a position, not a journey.
            */}
            {canDrawRoute ? (
              <div className="mt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowMap(!showMap)}
                  aria-expanded={showMap}
                >
                  <MapIcon className="mr-2 size-4" aria-hidden />
                  {showMap ? t("admin.journey.hide") : t("admin.journey.show")}
                </Button>

                {showMap ? (
                  <div className="mt-3">
                    <h4 className="text-sm font-semibold">{t("admin.journey.title")}</h4>
                    {/*
                      Its own caveat, not a repeat of the panel's. The panel's warns that a
                      GAP is not an absence of person; this one warns that a LINE is not
                      necessarily movement — at this venue the readings are ±35 m and the
                      whole day's spread is 60 m, so the two say different things and a
                      reader needs both.
                    */}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("admin.journey.caveat")}
                    </p>
                    <Suspense
                      fallback={
                        <div
                          className="mt-3 h-[340px] w-full animate-pulse rounded-lg border bg-muted"
                          aria-hidden
                        />
                      }
                    >
                      <JourneyMap pings={pings} venue={venue.data ?? null} />
                    </Suspense>
                  </div>
                ) : null}
              </div>
            ) : null}

            <ul className="mt-4 max-h-72 overflow-y-auto">
              {pings.map((p) => (
                <PingRow key={p.id} ping={p} />
              ))}
            </ul>
          </>
        )}
      </StateBoundary>
    </section>
  );
}
