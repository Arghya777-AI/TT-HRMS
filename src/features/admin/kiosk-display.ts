/**
 * kiosk-display.ts — the vocabulary layer for `/admin/kiosk/**` and
 * `/admin/settings/health`.
 *
 * Every raw enum the database speaks (`no_match`, `consent_withdrawn`,
 * `pending_pairing`, `degraded`) is mapped to a catalogue string and a tone here,
 * once. D-10 forbids a raw code reaching a screen, and the way to guarantee that
 * is to make the mapping a lookup an agent cannot forget rather than a `switch`
 * repeated in six pages.
 *
 * `Record<..., MessageKey>` is deliberate: a typo in a key is a typecheck error,
 * not a literal `admin.kiosk.match.outcome.typo` rendered at the gate.
 */
import { t, type MessageKey } from "@/shared/i18n/en";
import type { StatusChipEntry, StatusTone } from "@/shared/ui/StatusChip";
import type { DeviceState } from "./api/kiosk.api";
import type { HealthStatus } from "./api/health.api";

// -----------------------------------------------------------------------------
// Kiosk devices
// -----------------------------------------------------------------------------

const DEVICE_STATE_KEY: Readonly<Record<DeviceState, MessageKey>> = {
  pending_pairing: "admin.kiosk.devices.state.pending_pairing",
  active: "admin.kiosk.devices.state.active",
  degraded: "admin.kiosk.devices.state.degraded",
  offline: "admin.kiosk.devices.state.offline",
  revoked: "admin.kiosk.devices.state.revoked",
};

const DEVICE_STATE_TONE: Readonly<Record<DeviceState, StatusTone>> = {
  pending_pairing: "info",
  active: "success",
  degraded: "warn",
  offline: "warn",
  revoked: "danger",
};

export function deviceStateChip(state: DeviceState): Record<string, StatusChipEntry> {
  return { [state]: { label: t(DEVICE_STATE_KEY[state]), tone: DEVICE_STATE_TONE[state] } };
}

// -----------------------------------------------------------------------------
// Match outcomes (secure.face_match_log.outcome — 9 values)
// -----------------------------------------------------------------------------

const OUTCOME_KEY: Readonly<Record<string, MessageKey>> = {
  matched: "admin.kiosk.match.outcome.matched",
  no_match: "admin.kiosk.match.outcome.no_match",
  ambiguous: "admin.kiosk.match.outcome.ambiguous",
  no_face: "admin.kiosk.match.outcome.no_face",
  multiple_faces: "admin.kiosk.match.outcome.multiple_faces",
  low_quality: "admin.kiosk.match.outcome.low_quality",
  liveness_failed: "admin.kiosk.match.outcome.liveness_failed",
  error: "admin.kiosk.match.outcome.error",
  duplicate_suppressed: "admin.kiosk.match.outcome.duplicate_suppressed",
};

const OUTCOME_TONE: Readonly<Record<string, StatusTone>> = {
  matched: "success",
  no_match: "warn",
  ambiguous: "danger",
  no_face: "neutral",
  multiple_faces: "danger",
  low_quality: "warn",
  liveness_failed: "danger",
  error: "danger",
  duplicate_suppressed: "neutral",
};

/**
 * `StatusChip` falls back to a humanised label for an unmapped status, so an
 * outcome the engine adds later degrades to 'Some New Outcome' rather than to a
 * blank cell — visible, honest, and never a raw snake_case token.
 */
export function matchOutcomeChip(outcome: string): Record<string, StatusChipEntry> {
  const key = OUTCOME_KEY[outcome];
  if (key === undefined) return {};
  return { [outcome]: { label: t(key), tone: OUTCOME_TONE[outcome] ?? "neutral" } };
}

export function matchOutcomeLabel(outcome: string): string | null {
  const key = OUTCOME_KEY[outcome];
  return key === undefined ? null : t(key);
}

// -----------------------------------------------------------------------------
// Enrolment gaps (v_enrolment_coverage.gap_kind)
// -----------------------------------------------------------------------------

const GAP_KEY: Readonly<Record<string, MessageKey>> = {
  no_consent: "admin.kiosk.enrolment.gap.no_consent",
  consented_not_enrolled: "admin.kiosk.enrolment.gap.consented_not_enrolled",
  consent_withdrawn: "admin.kiosk.enrolment.gap.consent_withdrawn",
};

const GAP_TONE: Readonly<Record<string, StatusTone>> = {
  // A withdrawal is a lawful choice, not a problem to chase (§5.10) — neutral.
  consent_withdrawn: "neutral",
  no_consent: "warn",
  consented_not_enrolled: "info",
};

export function gapChip(gapKind: string | null): Record<string, StatusChipEntry> {
  if (gapKind === null) return {};
  const key = GAP_KEY[gapKind];
  if (key === undefined) return {};
  return { [gapKind]: { label: t(key), tone: GAP_TONE[gapKind] ?? "neutral" } };
}

// -----------------------------------------------------------------------------
// Template state + quality band
// -----------------------------------------------------------------------------

const TEMPLATE_STATE_KEY: Readonly<Record<string, MessageKey>> = {
  active: "admin.kiosk.templates.state.active",
  pending_approval: "admin.kiosk.templates.state.pending_approval",
  inactive: "admin.kiosk.templates.state.inactive",
  purged: "admin.kiosk.templates.state.purged",
};

const TEMPLATE_STATE_TONE: Readonly<Record<string, StatusTone>> = {
  active: "success",
  pending_approval: "warn",
  inactive: "neutral",
  purged: "danger",
};

export function templateStateChip(state: string): Record<string, StatusChipEntry> {
  const key = TEMPLATE_STATE_KEY[state];
  if (key === undefined) return {};
  return { [state]: { label: t(key), tone: TEMPLATE_STATE_TONE[state] ?? "neutral" } };
}

const QUALITY_KEY: Readonly<Record<string, MessageKey>> = {
  good: "admin.kiosk.templates.quality.good",
  fair: "admin.kiosk.templates.quality.fair",
  poor: "admin.kiosk.templates.quality.poor",
};

const QUALITY_TONE: Readonly<Record<string, StatusTone>> = {
  good: "success",
  fair: "warn",
  poor: "danger",
};

/**
 * The band, never the number. The score behind it is a face-similarity measure
 * and putting it on screen is putting a match score on screen.
 */
export function qualityChip(band: string): Record<string, StatusChipEntry> {
  const key = QUALITY_KEY[band];
  if (key === undefined) return {};
  return { [band]: { label: t(key), tone: QUALITY_TONE[band] ?? "neutral" } };
}

export function qualityLabel(band: string): string {
  const key = QUALITY_KEY[band];
  return key === undefined ? band : t(key);
}

// -----------------------------------------------------------------------------
// Consent status (assembled register)
// -----------------------------------------------------------------------------

export type ConsentStatus = "granted" | "withdrawn" | "none";

const CONSENT_KEY: Readonly<Record<ConsentStatus, MessageKey>> = {
  granted: "admin.kiosk.consent.status.granted",
  withdrawn: "admin.kiosk.consent.status.withdrawn",
  none: "admin.kiosk.consent.status.none",
};

const CONSENT_TONE: Readonly<Record<ConsentStatus, StatusTone>> = {
  granted: "success",
  withdrawn: "neutral",
  none: "warn",
};

export function consentChip(status: ConsentStatus): Record<string, StatusChipEntry> {
  return { [status]: { label: t(CONSENT_KEY[status]), tone: CONSENT_TONE[status] } };
}

// -----------------------------------------------------------------------------
// Kiosk operators
// -----------------------------------------------------------------------------

export function operatorStateChip(isActive: boolean): Record<string, StatusChipEntry> {
  return isActive
    ? { active: { label: t("admin.kiosk.operators.state.active"), tone: "success" } }
    : { revoked: { label: t("admin.kiosk.operators.state.revoked"), tone: "danger" } };
}

// -----------------------------------------------------------------------------
// System health + job runs
// -----------------------------------------------------------------------------

const HEALTH_KEY: Readonly<Record<HealthStatus, MessageKey>> = {
  ok: "admin.settings.health.status.ok",
  degraded: "admin.settings.health.status.degraded",
  down: "admin.settings.health.status.down",
  unknown: "admin.settings.health.status.unknown",
};

const HEALTH_TONE: Readonly<Record<HealthStatus, StatusTone>> = {
  ok: "success",
  degraded: "warn",
  down: "danger",
  unknown: "neutral",
};

export function healthChip(status: HealthStatus): Record<string, StatusChipEntry> {
  return { [status]: { label: t(HEALTH_KEY[status]), tone: HEALTH_TONE[status] } };
}

export function healthLabel(status: HealthStatus): string {
  return t(HEALTH_KEY[status]);
}

// -----------------------------------------------------------------------------
// Notification channels
// -----------------------------------------------------------------------------

const CHANNEL_KEY: Readonly<Record<string, MessageKey>> = {
  email: "admin.settings.notif.channel.email",
  sms: "admin.settings.notif.channel.sms",
  whatsapp: "admin.settings.notif.channel.whatsapp",
  in_app: "admin.settings.notif.channel.in_app",
  push: "admin.settings.notif.channel.push",
};

export function channelLabel(channel: string): string {
  const key = CHANNEL_KEY[channel];
  return key === undefined ? channel : t(key);
}

// -----------------------------------------------------------------------------
// Enrolment request source
// -----------------------------------------------------------------------------

const VIA_KEY: Readonly<Record<string, MessageKey>> = {
  web: "admin.kiosk.enrolment.requests.via.web",
  kiosk: "admin.kiosk.enrolment.requests.via.kiosk",
};

export function requestViaLabel(via: string): string {
  const key = VIA_KEY[via];
  return key === undefined ? via : t(key);
}
