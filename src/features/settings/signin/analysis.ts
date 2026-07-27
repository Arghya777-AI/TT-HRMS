/**
 * analysis.ts — turning one `sessions_audit` row into words a person can act on.
 *
 * Everything here is PURE and synchronous: the same row always produces the same
 * sentence, which is what makes it safe to use on three screens (the employee's
 * activity trail, the security tab's card, and the admin sign-in register) without
 * them ever describing the same event differently.
 *
 * THE HONESTY RULES THIS FILE ENFORCES, because a location trail a person does not
 * understand is worse than none:
 *
 *  1. A place is only stated when `geo` actually carries one. `ip` is NEVER turned
 *     into a city — nothing in this build does IP geolocation, so pretending the
 *     network address is a location would invent the one fact people most want to
 *     dispute. A row without `geo` says "Location was not shared".
 *  2. "New device" and "New location" mean "the first time in your WHOLE recorded
 *     history", so they are only emitted when the caller can prove the rows it
 *     passed in ARE the whole history (`historyComplete`). With a truncated window
 *     the notes are withheld and the screen says why.
 *  3. The earliest event in a history is never flagged as new: novelty means
 *     "different from what came before", and nothing came before it.
 *  4. `auth_method` is rendered from the SIX values `ck_sessions_audit__auth_method`
 *     actually permits: password, passkey, magic_link, otp, kiosk_pin (migration
 *     20260801000400 §5) and `face`, added to that CHECK by migration
 *     20260801012200 and written by the `face-login` edge function as a
 *     `login_success` with `auth_method = 'face'`. A face WEB SIGN-IN therefore does
 *     land in this record and is described as one; the face scans at the attendance
 *     kiosk are punches in `secure.face_match_log`, are not sign-ins, and never
 *     reach `sessions_audit`. Nothing here reads a descriptor: the six columns this
 *     module sees carry no biometric measurement at all.
 *  5. An `event` value outside the ten in `ck_sessions_audit__event` renders as
 *     "recorded, not recognised" — never silently dropped.
 *
 * Verified against migration 20260801000400_identity_core.sql §5 (columns and both
 * CHECK vocabularies) and 20260801000660_identity_rls_policies.sql §5 (who may read
 * which rows).
 */
import { istParts } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import {
  SIGNIN_EVENTS_FAILURE,
  SIGNIN_EVENTS_SECURITY,
  SIGNIN_EVENTS_SUCCESS,
  SIGNIN_EVENT_BACKGROUND,
  type SignInEventRow,
} from "../api/signin-activity.api";

/* ── Time of day ──────────────────────────────────────────────────────────── */

/**
 * The venue's ordinary hours in IST. Anything before 07:00 or from 21:00 is worth
 * a note — a wedding venue does run late, so this is "unusual", never "wrong".
 * `/admin/audit/sessions` imports these so the two screens cannot drift apart.
 */
export const NORMAL_HOUR_FROM = 7;
export const NORMAL_HOUR_TO = 21;

/** True when the IST wall-clock hour of the instant is outside 07:00–21:00. */
export function isOutsideNormalHours(instant: string): boolean {
  const { hour } = istParts(instant);
  return hour >= NORMAL_HOUR_TO || hour < NORMAL_HOUR_FROM;
}

/* ── Where from ───────────────────────────────────────────────────────────── */

export interface SignInPlace {
  /** 'Bengaluru, Karnataka, IN' or 'Near 12.9716, 77.5946'. */
  readonly label: string;
  /** Comparison key for the new-location note. */
  readonly key: string;
  /** True when the row carried coordinates rather than only a place name. */
  readonly hasCoordinates: boolean;
  /** '±35 m' style qualifier when the row recorded an accuracy. */
  readonly accuracy: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickText(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function pickNumber(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Read whatever the auth path happened to put in `geo`.
 *
 * The column is a free `jsonb` written opportunistically, so the shape is not a
 * contract: several spellings of the same fact are accepted and anything
 * unrecognised yields `null`, which the screens render as "location was not
 * shared". Returning a half-parsed object would put an empty place on screen.
 */
export function readPlace(geo: unknown): SignInPlace | null {
  const rec = asRecord(geo);
  if (rec === null) return null;

  const city = pickText(rec, ["city", "town", "locality", "place", "name"]);
  const region = pickText(rec, ["region", "state", "region_name", "admin_area"]);
  const country = pickText(rec, ["country", "country_name", "country_code", "cc"]);
  const lat = pickNumber(rec, ["lat", "latitude"]);
  const lon = pickNumber(rec, ["lon", "lng", "long", "longitude"]);
  const accuracyMetres = pickNumber(rec, ["accuracy_m", "accuracy", "accuracy_metres"]);
  const accuracy =
    accuracyMetres === null
      ? null
      : t("signIn.place.accuracy", { metres: Math.round(accuracyMetres) });

  const named = [city, region, country].filter((part): part is string => part !== null);
  if (named.length > 0) {
    const label = named.join(", ");
    return {
      label,
      key: label.toLowerCase(),
      hasCoordinates: lat !== null && lon !== null,
      accuracy,
    };
  }

  if (lat !== null && lon !== null) {
    // Four decimals ≈ 11 m. Shown as the coordinates they are, not as a place
    // name we would be guessing.
    const label = t("signIn.place.coords", { lat: lat.toFixed(4), lon: lon.toFixed(4) });
    return { label, key: `${lat.toFixed(3)},${lon.toFixed(3)}`, hasCoordinates: true, accuracy };
  }

  return null;
}

/* ── Which device ─────────────────────────────────────────────────────────── */

export interface SignInDevice {
  /** 'Chrome on Android', 'Kiosk device at the venue', 'Device not recorded'. */
  readonly label: string;
  /** Identity for the new-device note: the device id if there is one, else the UA. */
  readonly key: string | null;
  /** The raw user-agent string, for the technical-detail block only. */
  readonly userAgent: string | null;
  readonly deviceId: string | null;
  readonly isKiosk: boolean;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bCriOS\//, "Chrome"],
  [/\bFxiOS\//, "Firefox"],
  [/\bFirefox\//, "Firefox"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bWindows NT\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bLinux\b/, "Linux"],
];

function matchFirst(
  value: string,
  table: readonly (readonly [RegExp, string])[],
): string | null {
  for (const [pattern, label] of table) if (pattern.test(value)) return label;
  return null;
}

/** 'a1b2c3d4-…' — enough of an opaque device id to compare two rows by eye. */
function shortId(deviceId: string): string {
  return deviceId.length <= 12 ? deviceId : `${deviceId.slice(0, 8)}…`;
}

/**
 * Name the device in words, with the raw strings kept for the detail block.
 *
 * A user agent is a claim the browser makes about itself, so the parsed label is
 * a convenience and the exact string stays one click away — never replaced by a
 * guess the employee cannot check.
 */
export function readDevice(row: {
  readonly device_id: string | null;
  readonly user_agent: string | null;
  readonly auth_method: string | null;
}): SignInDevice {
  const isKiosk = row.auth_method === "kiosk_pin";
  const key = row.device_id ?? row.user_agent ?? null;
  const base = { key, userAgent: row.user_agent, deviceId: row.device_id, isKiosk };

  if (isKiosk) return { ...base, label: t("signIn.device.kiosk") };

  if (row.user_agent !== null && row.user_agent.trim() !== "") {
    const ua = row.user_agent;
    const browser = matchFirst(ua, BROWSERS);
    const platform = matchFirst(ua, PLATFORMS);
    if (browser !== null && platform !== null) {
      return { ...base, label: t("signIn.device.browserOn", { browser, platform }) };
    }
    const single = browser ?? platform;
    if (single !== null) return { ...base, label: single };
    // Unrecognised agent: show what was recorded, trimmed, rather than "unknown".
    return { ...base, label: ua.length <= 48 ? ua : `${ua.slice(0, 47)}…` };
  }

  if (row.device_id !== null && row.device_id.trim() !== "") {
    return { ...base, label: t("signIn.device.tagged", { id: shortId(row.device_id) }) };
  }

  return { ...base, label: t("signIn.device.none") };
}

/* ── Which method ─────────────────────────────────────────────────────────── */

const METHOD_LABEL: Readonly<Record<string, string>> = {
  password: t("signIn.method.password"),
  passkey: t("signIn.method.passkey"),
  magic_link: t("signIn.method.magicLink"),
  otp: t("signIn.method.otp"),
  kiosk_pin: t("signIn.method.kioskPin"),
  face: t("signIn.method.face"),
};

/** One of the six permitted methods, or "Method not recorded" for NULL. */
export function signInMethodLabel(method: string | null): string {
  if (method === null || method.trim() === "") return t("signIn.method.none");
  const known = METHOD_LABEL[method];
  if (known !== undefined) return known;
  // A method value the CHECK constraint has grown since: humanised, not hidden.
  const words = method.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ── What happened ────────────────────────────────────────────────────────── */

/**
 * The shape of an event, for the icon and the tone. Coarser than `event` on
 * purpose: a screen needs five visual classes, not ten.
 */
export type SignInEventKind =
  | "success"
  | "failure"
  | "signOut"
  | "renewal"
  | "credential"
  | "challenge"
  | "other";

const EVENT_KIND: Readonly<Record<string, SignInEventKind>> = {
  login_success: "success",
  passkey_used: "success",
  login_failed: "failure",
  logout: "signOut",
  session_revoked: "signOut",
  token_refresh: "renewal",
  password_changed: "credential",
  password_reset_requested: "credential",
  passkey_registered: "credential",
  mfa_challenge: "challenge",
};

export function signInEventKind(event: string): SignInEventKind {
  return EVENT_KIND[event] ?? "other";
}

const SUCCESS_SENTENCE: Readonly<Record<string, string>> = {
  password: t("signIn.event.signedInPassword"),
  passkey: t("signIn.event.signedInPasskey"),
  magic_link: t("signIn.event.signedInEmailLink"),
  otp: t("signIn.event.signedInCode"),
  kiosk_pin: t("signIn.event.signedInKiosk"),
  // `face-login` writes ONE row: `login_success` + `auth_method = 'face'`. Without
  // an entry here the most security-sensitive sign-in in the product would read as
  // the generic "You signed in" — the exact fact an employee needs to dispute.
  face: t("signIn.event.signedInFace"),
};

const EVENT_SENTENCE: Readonly<Record<string, string>> = {
  login_failed: t("signIn.event.refused"),
  logout: t("signIn.event.signedOut"),
  token_refresh: t("signIn.event.renewed"),
  password_reset_requested: t("signIn.event.resetRequested"),
  password_changed: t("signIn.event.passwordChanged"),
  passkey_registered: t("signIn.event.passkeyAdded"),
  passkey_used: t("signIn.event.passkeyUsed"),
  mfa_challenge: t("signIn.event.secondStep"),
  session_revoked: t("signIn.event.sessionRevoked"),
};

/**
 * The row as one sentence addressed to the employee whose row it is.
 *
 * A successful sign-in is described BY ITS METHOD, because "you signed in" and
 * "you were signed in at a kiosk with your PIN" are different enough facts that
 * collapsing them would defeat the point of the screen.
 */
export function describeSignInEvent(row: {
  readonly event: string;
  readonly auth_method: string | null;
}): string {
  if (row.event === "login_success") {
    const method = row.auth_method;
    if (method !== null) {
      const sentence = SUCCESS_SENTENCE[method];
      if (sentence !== undefined) return sentence;
    }
    return t("signIn.event.signedIn");
  }
  return EVENT_SENTENCE[row.event] ?? t("signIn.event.other", { event: row.event });
}

/* ── The trail ────────────────────────────────────────────────────────────── */

/** The notes a row can carry. Ordered by how much a person should care. */
export type SignInFlag = "failed" | "newDevice" | "newPlace" | "outOfHours" | "thisBrowser";

export const SIGNIN_FLAG_ORDER: readonly SignInFlag[] = [
  "failed",
  "newDevice",
  "newPlace",
  "outOfHours",
  "thisBrowser",
];

export interface SignInRowView {
  readonly id: string;
  /** UTC instant as stored; every screen formats it with `fmtDateTime` (IST). */
  readonly recordedAt: string;
  readonly event: string;
  readonly kind: SignInEventKind;
  /** The plain-language sentence. */
  readonly headline: string;
  readonly methodLabel: string;
  /** `null` when `geo` carried nothing — rendered as "location was not shared". */
  readonly place: SignInPlace | null;
  readonly device: SignInDevice;
  readonly ip: string | null;
  readonly failureReason: string | null;
  readonly attemptedEmail: string | null;
  readonly flags: readonly SignInFlag[];
}

export interface SignInTrailOptions {
  /**
   * True only when the rows passed in ARE every row the profile has. The
   * new-device and new-location notes are withheld otherwise: "first time ever"
   * cannot be read off a truncated window.
   */
  readonly historyComplete: boolean;
  /** `navigator.userAgent`, to mark the row that is this very browser. */
  readonly currentUserAgent?: string | null;
}

/**
 * Analyse a newest-first page of rows into newest-first view models.
 *
 * Novelty is computed oldest-first (that is the only direction in which "first
 * time" means anything) and the result is flipped back, so the caller's ordering
 * is preserved.
 */
export function buildSignInTrail(
  rows: readonly SignInEventRow[],
  options: SignInTrailOptions,
): readonly SignInRowView[] {
  const oldestFirst = [...rows].reverse();
  const seenDevices = new Set<string>();
  const seenPlaces = new Set<string>();
  const current = options.currentUserAgent ?? null;

  const analysed = oldestFirst.map((row) => {
    const device = readDevice(row);
    const place = readPlace(row.geo);

    const deviceIsNew = device.key !== null && !seenDevices.has(device.key) && seenDevices.size > 0;
    const placeIsNew = place !== null && !seenPlaces.has(place.key) && seenPlaces.size > 0;
    if (device.key !== null) seenDevices.add(device.key);
    if (place !== null) seenPlaces.add(place.key);

    const flags: SignInFlag[] = [];
    if (row.event === "login_failed" || (row.failure_reason ?? "") !== "") flags.push("failed");
    if (options.historyComplete && deviceIsNew) flags.push("newDevice");
    if (options.historyComplete && placeIsNew) flags.push("newPlace");
    if (isOutsideNormalHours(row.recorded_at)) flags.push("outOfHours");
    if (current !== null && row.user_agent !== null && row.user_agent === current) {
      flags.push("thisBrowser");
    }

    const view: SignInRowView = {
      id: row.id,
      recordedAt: row.recorded_at,
      event: row.event,
      kind: signInEventKind(row.event),
      headline: describeSignInEvent(row),
      methodLabel: signInMethodLabel(row.auth_method),
      place,
      device,
      ip: row.ip,
      failureReason: row.failure_reason,
      attemptedEmail: row.attempted_email,
      flags,
    };
    return view;
  });

  return analysed.reverse();
}

/** The filter buttons over a loaded trail. Each is a set of `event` values. */
export type SignInTrailFilter = "activity" | "signIns" | "failures" | "security" | "renewals";

/**
 * The filters are defined by EVENT VALUE, from the same constants the server
 * counts use — not by the coarse visual `kind`.
 *
 * That is deliberate: "Security changes" must select exactly the rows the
 * "Security changes" tile counted, or the list under a number would be a
 * different set from the number (the `7 vs 8` defect). Between them the four
 * groups cover all ten values of `ck_sessions_audit__event`, so no recorded event
 * can fall through every filter and become invisible.
 */
const FILTER_EVENTS: Readonly<Record<SignInTrailFilter, readonly string[] | null>> = {
  activity: null,
  signIns: [...SIGNIN_EVENTS_SUCCESS, "logout"],
  failures: [...SIGNIN_EVENTS_FAILURE],
  security: [...SIGNIN_EVENTS_SECURITY],
  renewals: [SIGNIN_EVENT_BACKGROUND],
};

/**
 * Apply a filter to already-analysed rows.
 *
 * Client-side by design: the four numbers above the list are server counts over
 * the WHOLE record, and the screen states that these buttons narrow only the
 * loaded events. Re-querying per button would make five reads describe five
 * different moments of the same record.
 */
export function filterSignInTrail(
  rows: readonly SignInRowView[],
  filter: SignInTrailFilter,
): readonly SignInRowView[] {
  const events = FILTER_EVENTS[filter];
  if (events === null) return rows;
  return rows.filter((row) => events.includes(row.event));
}
