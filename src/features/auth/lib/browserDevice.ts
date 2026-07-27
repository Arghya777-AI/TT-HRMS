/**
 * browserDevice.ts — the opaque per-browser id that makes "this same browser
 * again" answerable on the employee's own sign-in record.
 *
 * WHY: `public.sessions_audit.device_id` is what the activity trail compares to
 * decide "New device" (`features/settings/signin/analysis.ts#readDevice` prefers
 * `device_id` over the user agent, because two colleagues on the same phone model
 * share a user-agent string and are not the same device). Nothing in the browser
 * populated it, so the trail fell back to the user agent for every web sign-in.
 *
 * WHAT IT IS: one random UUID v4, generated on first use and kept in
 * localStorage. That is all. It is NOT a fingerprint — nothing is derived from
 * the hardware, the fonts, the canvas or the screen — and it is NOT an
 * identifier of a person: it is a label this browser gives itself so the audit
 * row can say "the same browser as last time".
 *
 * WHAT IT IS WORTH: nothing as a security control, and `auth-session-record`'s
 * header says so — `deviceId` is client-attested and a caller may send anything.
 * It survives until site data is cleared, and clearing it simply means the next
 * sign-in is honestly reported as a new device.
 *
 * DPDP: no new category of personal data. A random opaque id, visible to the
 * employee on their own Security screen next to the row it labels.
 */

const STORE_KEY = "tt-signin-device-v1";

/** `auth-session-record` bounds `deviceId` at 8–128 characters; a UUID is 36. */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

function isUsable(value: string | null): value is string {
  return value !== null && value.length >= MIN_LENGTH && value.length <= MAX_LENGTH;
}

/**
 * The id for this browser, or `null` when it cannot be stored.
 *
 * `null` is a supported outcome, not a failure: private-mode Safari and a
 * storage-blocked embed both throw on `localStorage`, and a sign-in must never
 * depend on being able to label the device. The audit row is then written
 * without one and the trail says "Device not recorded".
 */
export function browserDeviceId(): string | null {
  try {
    const existing = localStorage.getItem(STORE_KEY);
    if (isUsable(existing)) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(STORE_KEY, created);
    return created;
  } catch {
    return null;
  }
}
