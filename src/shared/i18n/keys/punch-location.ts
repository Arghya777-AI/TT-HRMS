/**
 * i18n keys owned EXCLUSIVELY by `shared/ui/PunchLocation.tsx` and the punch-place
 * hook — the place name, coordinate and accuracy shown wherever a punch appears.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so
 * two people appending to one catalogue silently lose each other's keys.
 *
 * MOST OF THIS COPY EXISTS TO PREVENT A WRONG CONCLUSION. A coordinate on screen
 * invites a reader to believe the system knows where somebody was, to the metre.
 * `accuracyUnknown`, `coarse` and `noFix` all exist to keep that belief from
 * forming when the data does not support it.
 */
export const keysPunchLocation = {
  // ── The location itself ───────────────────────────────────────────────────
  "punch.place.title": "Where this punch was taken",
  /** Shown while the reverse geocode is in flight. The coordinate is already visible. */
  "punch.place.looking": "Looking up the address…",
  "punch.place.coordinates": "{lat}, {lng}",
  "punch.place.accuracy": "± {metres} m",
  /** Row labels in the detail block's definition list. */
  "punch.place.coordinatesLabel": "Latitude, longitude",
  "punch.place.accuracyLabel": "Accuracy",
  /**
   * NOT "± unknown". A missing accuracy reading is a fact about the device, and
   * saying so plainly stops the six decimal places from reading as survey-grade.
   */
  "punch.place.accuracyUnknown": "accuracy not reported",
  "punch.place.accuracyHint":
    "How far off the device believed it might be. A large figure means the position came from a network or cell estimate rather than GPS — the coordinate is a centre point, not a pin.",

  // ── When there is no location at all ──────────────────────────────────────
  "punch.place.noFix": "No location recorded",
  "punch.place.noFixHint":
    "This punch was taken without coordinates — either the device had location switched off, or it was recorded by an operator or an import. It is not evidence that the person was elsewhere.",

  // ── When the geocoder had nothing to say ──────────────────────────────────
  "punch.place.notFound": "No street address at this point",
  "punch.place.notFoundHint":
    "OpenStreetMap has no address recorded at this coordinate. The position itself still stands — open the map to see it.",
  "punch.place.unavailable": "Address lookup unavailable",
  "punch.place.throttled": "Address will load shortly",
  "punch.place.throttledHint":
    "Several places are being looked up at once and OpenStreetMap allows one a second. This resolves itself — nothing is wrong.",

  // ── Map link ──────────────────────────────────────────────────────────────
  "punch.place.openMap": "View on OpenStreetMap",
  "punch.place.openMapAria": "Open {place} on OpenStreetMap in a new tab",
  "punch.place.copy": "Copy coordinates",
  "punch.place.copied": "Copied",

  // ── Provenance ────────────────────────────────────────────────────────────
  "punch.place.source": "Address from OpenStreetMap",
  "punch.place.sourceCached": "Address from OpenStreetMap · cached",

  // ── Compact form, for a table cell ────────────────────────────────────────
  "punch.place.column": "Location",
} as const;
