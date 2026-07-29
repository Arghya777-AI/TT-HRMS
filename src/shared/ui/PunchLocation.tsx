/**
 * PunchLocation — where a punch was taken, shown honestly.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT IT ALWAYS SHOWS TOGETHER
 *
 * The place name, the coordinate, AND the accuracy. Never one without the others,
 * because each alone misleads:
 *
 *   - A place name alone ("Jayanagar 4T Block") hides that the fix might be
 *     500 m wide, so it reads as "was at the office".
 *   - A coordinate alone is six decimal places of false precision — see
 *     `lib/punchPlace.ts`.
 *   - Accuracy alone is meaningless.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE COORDINATE RENDERS IMMEDIATELY; THE NAME ARRIVES LATER
 *
 * The coordinate and accuracy come from the punch row that is already on screen.
 * The place name needs a network round-trip to OpenStreetMap. So the coordinate
 * is drawn first and the address fills in — rather than the whole block showing
 * a spinner and the reader losing access to data we already had.
 *
 * If the lookup fails, is throttled, or the provider genuinely has no address for
 * the point, the coordinate and accuracy STILL stand and the map link still works.
 * A geocoder being unavailable must never make a recorded position disappear.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT REPLACED THE GEOFENCE VERDICT
 *
 * This component took over from an inside/outside badge. That badge answered a
 * question nobody could act on ("was this within a radius somebody configured
 * once?") and, worse, rendered a NULL — "we never evaluated it" — as a boundary
 * failure. The actual place name answers the question a manager is really asking,
 * which is "where was this person", and it degrades to the truth instead of to an
 * accusation.
 */
import { useState } from "react";
import { ExternalLink, MapPin, Copy, Check } from "lucide-react";
import { t } from "@/shared/i18n/en";
import {
  formatCoordinates,
  openStreetMapUrl,
  readPunchFix,
  roundAccuracy,
  shortPlaceLabel,
  type PunchLocationColumns,
} from "@/lib/punchPlace";
import { usePunchPlace } from "@/features/attendance/hooks/usePunchPlace";

export interface PunchLocationProps {
  /** The punch row's own location columns, straight from `v_attendance_punch_detail`. */
  row: PunchLocationColumns;
  /**
   * `inline` — one line for a table cell: short place, accuracy, map link.
   * `detail` — the full block: full address, coordinate, accuracy, map, copy.
   * `compact` — the same FACTS as `detail` in about a third of the height, for a
   *   card sitting in a column beside other cards. Nothing is removed: the place,
   *   the full address, the coordinate and the accuracy are all still on screen,
   *   because those were asked for on every punch and an employee may need them
   *   later. What changes is the typesetting — the coordinate and the accuracy
   *   share one line instead of occupying a two-row definition list, and the long
   *   geocoder address is clamped to two lines with the whole of it in `title`.
   */
  variant?: "inline" | "detail" | "compact";
  /**
   * Whether to render anything at all when the punch carries no coordinate.
   * A detail panel says "No location recorded" (the absence is information);
   * a dense table cell usually prefers a dash, so it passes `false`.
   */
  showWhenAbsent?: boolean;
  className?: string;
}

export function PunchLocation({
  row,
  variant = "inline",
  showWhenAbsent = true,
  className,
}: PunchLocationProps) {
  const fix = readPunchFix(row);
  // Always called — hooks cannot be conditional. `usePunchPlace` takes null and
  // disables itself, which is why it accepts a nullable fix in the first place.
  const place = usePunchPlace(fix);

  if (fix === null) {
    if (!showWhenAbsent) return <span className="text-muted-foreground">—</span>;
    return (
      <span
        className={`text-sm text-muted-foreground ${className ?? ""}`}
        title={t("punch.place.noFixHint")}
      >
        {t("punch.place.noFix")}
      </span>
    );
  }

  const coordinates = formatCoordinates(fix);
  const accuracyText =
    fix.accuracyMetres === null
      ? t("punch.place.accuracyUnknown")
      : t("punch.place.accuracy", { metres: roundAccuracy(fix.accuracyMetres) });
  const mapUrl = openStreetMapUrl(fix);

  const outcome = place.data?.outcome;
  const shortLabel = place.data === undefined ? null : shortPlaceLabel(place.data.parts);

  /**
   * The name line, in priority order. Each branch is a DIFFERENT fact, and the
   * copy for each says which — a throttle is not a failure and "no address here"
   * is not "lookup broken".
   */
  const nameLine = ((): { text: string; hint: string | null; muted: boolean } => {
    if (place.isPending) {
      return { text: t("punch.place.looking"), hint: null, muted: true };
    }
    if (outcome === "resolved" && shortLabel !== null) {
      return { text: shortLabel, hint: place.data?.displayName ?? null, muted: false };
    }
    if (outcome === "not_found") {
      return { text: t("punch.place.notFound"), hint: t("punch.place.notFoundHint"), muted: true };
    }
    if (outcome === "provider_throttled") {
      return { text: t("punch.place.throttled"), hint: t("punch.place.throttledHint"), muted: true };
    }
    // `provider_error`, a query error, or a resolved answer whose parts were all
    // empty. The coordinate below is still the answer to "where".
    return {
      text: t("punch.place.unavailable"),
      hint: place.data?.reason ?? place.error?.message ?? null,
      muted: true,
    };
  })();

  if (variant === "inline") {
    return (
      <span className={`inline-flex items-center gap-1.5 text-sm ${className ?? ""}`}>
        <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          className={nameLine.muted ? "text-muted-foreground" : "text-foreground"}
          title={nameLine.hint ?? undefined}
        >
          {nameLine.text}
        </span>
        {/* Accuracy travels WITH the name even in the dense form. Dropping it here
            is exactly how a 2 km estimate starts reading as a precise location. */}
        <span className="text-xs text-muted-foreground" title={t("punch.place.accuracyHint")}>
          {accuracyText}
        </span>
        <a
          href={mapUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t("punch.place.openMapAria", { place: nameLine.text })}
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </span>
    );
  }

  if (variant === "compact") {
    return (
      <div className={`min-w-0 space-y-1 ${className ?? ""}`}>
        <div className="flex items-start gap-1.5">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div
              className={`truncate text-sm font-medium ${
                nameLine.muted ? "text-muted-foreground" : "text-foreground"
              }`}
              title={nameLine.text}
            >
              {nameLine.text}
            </div>
            {/* Clamped, not dropped. The full address is the one line that made this
                panel four rows tall on a narrow column, and it is also the line that
                tells somebody which gate they were at — so it stays, at two lines,
                with the rest reachable on hover and by a screen reader. */}
            {outcome === "resolved" &&
              place.data?.displayName !== null &&
              place.data?.displayName !== undefined &&
              place.data.displayName !== nameLine.text && (
                <div
                  className="line-clamp-2 text-xs leading-snug text-muted-foreground"
                  title={place.data.displayName}
                >
                  {place.data.displayName}
                </div>
              )}
            {nameLine.muted && nameLine.hint !== null && (
              <div className="text-xs text-muted-foreground">{nameLine.hint}</div>
            )}
          </div>
        </div>

        {/* One line for four things that used to take four. `flex-wrap` so it
            degrades to two lines on a very narrow column rather than overflowing. */}
        <div className="ml-5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="num text-foreground">{coordinates}</span>
          <span className="text-muted-foreground" title={t("punch.place.accuracyHint")}>
            {accuracyText}
          </span>
          <a
            href={mapUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            aria-label={t("punch.place.openMapAria", { place: nameLine.text })}
          >
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            {t("punch.place.openMap")}
          </a>
          <CopyCoordinates value={coordinates} />
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <div className="flex items-start gap-2">
        <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <div
            className={`text-sm font-medium ${nameLine.muted ? "text-muted-foreground" : "text-foreground"}`}
          >
            {nameLine.text}
          </div>
          {/* The geocoder's FULL display name — the Google-Maps-style long line.
              Only when it says more than the short label already did. */}
          {outcome === "resolved" &&
            place.data?.displayName !== null &&
            place.data?.displayName !== undefined &&
            place.data.displayName !== nameLine.text && (
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {place.data.displayName}
              </div>
            )}
          {nameLine.muted && nameLine.hint !== null && (
            <div className="mt-0.5 text-xs text-muted-foreground">{nameLine.hint}</div>
          )}
        </div>
      </div>

      <dl className="ml-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t("punch.place.coordinatesLabel")}</dt>
        <dd className="num text-foreground">{coordinates}</dd>
        <dt className="text-muted-foreground">{t("punch.place.accuracyLabel")}</dt>
        <dd className="text-foreground" title={t("punch.place.accuracyHint")}>
          {accuracyText}
        </dd>
      </dl>

      <div className="ml-6 flex items-center gap-3 text-xs">
        <a
          href={mapUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          {t("punch.place.openMap")}
        </a>
        <CopyCoordinates value={coordinates} />
        {outcome === "resolved" && (
          <span className="text-muted-foreground">
            {place.data?.cached === true
              ? t("punch.place.sourceCached")
              : t("punch.place.source")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Copy the coordinate. Separate component so its `copied` state cannot re-render
 * the whole location block — and so a clipboard failure (Safari without a user
 * gesture, an insecure context) stays contained to this button.
 */
function CopyCoordinates({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            // Not a clock we depend on for correctness — purely the label
            // reverting, so a plain timeout is right here.
            window.setTimeout(() => setCopied(false), 1_500);
          })
          .catch(() => {
            // Clipboard refused. The coordinate is selectable on screen, so
            // there is nothing to tell the user that they cannot already see.
          });
      }}
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? t("punch.place.copied") : t("punch.place.copy")}
    </button>
  );
}
