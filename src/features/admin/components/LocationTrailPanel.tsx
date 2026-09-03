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
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Navigation, WifiOff } from "lucide-react";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "./Notice";
import { fmtDateTime } from "@/lib/datetime";
import { formatDistance } from "@/lib/venueDistance";
import { formatCoordinates, openStreetMapUrl, roundAccuracy } from "@/lib/punchPlace";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  COARSE_ABOVE_M,
  fetchLocationTrail,
  summariseTrail,
  type LocationPing,
} from "../api/locationTrail.api";

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
      <span className="num w-16 shrink-0 text-sm tabular-nums">
        {fmtDateTime(ping.captured_at).slice(-5)}
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
              <span className="inline-flex items-center gap-1">
                <Navigation className="size-3" aria-hidden />
                {t("admin.trail.window", {
                  from: fmtDateTime(summary.firstAt ?? "").slice(-5),
                  to: fmtDateTime(summary.lastAt ?? "").slice(-5),
                })}
              </span>
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
            </p>
            <ul className="mt-2 max-h-72 overflow-y-auto">
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
