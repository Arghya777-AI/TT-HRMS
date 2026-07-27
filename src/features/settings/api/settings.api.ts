/**
 * settings.api.ts — the E-18.1 (notification preferences) reads and writes.
 *
 * `public.notification_preferences` (migration 027) is real and self-writable:
 * RLS gives the signed-in profile SELECT/INSERT/UPDATE on its own rows, keyed
 * `(profile_id, event_code, channel)`. What is NOT available to an employee is
 * the CATALOGUE: `notification_templates` is P8 (admin) only, verified live —
 * 58 rows for the HR admin, 0 for an employee. So this module can read and edit
 * the preference rows that exist, and it deliberately cannot offer a list of
 * "events you could switch off", because the vocabulary of event codes is not
 * visible to the person whose preferences they are.
 *
 * That matters for honesty in a second way: `notification_templates
 * .is_transactional` is what decides whether a preference is even consulted (56
 * of the 58 seeded templates are transactional — "salary credited" and a no-show
 * alert cannot be switched off). An employee cannot read that flag, so a toggle
 * this screen offered for an unknown event could silently have no effect. The
 * screen therefore edits only rows that already exist and says plainly what it
 * cannot do.
 *
 * Not audited: `notification_preferences` is not in `audit.reason_required_tables`
 * (038), so `updateOne`/`insertOne` from the write layer are the correct helpers —
 * no reason header, no invented justification.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbUuid,
  eq,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { updateOne } from "@/shared/api/write";
import { notificationChannelSchema } from "@/features/notifications/api/notifications.api";

export const NOTIFICATION_PREFERENCES_TABLE = "notification_preferences";

/** `ck_notification_preferences__digest` (migration 027). */
export const digestFrequencySchema = z.enum(["immediate", "hourly", "daily", "weekly", "off"]);
export type DigestFrequency = z.infer<typeof digestFrequencySchema>;

export const notificationPreferenceSchema = z.object({
  id: dbUuid,
  profile_id: dbUuid,
  event_code: z.string(),
  channel: notificationChannelSchema,
  is_enabled: z.boolean(),
  /** `time` columns arrive as 'HH:MM:SS'; render with fmtCivilTime. */
  quiet_hours_start: z.string().nullable(),
  quiet_hours_end: z.string().nullable(),
  digest_frequency: digestFrequencySchema,
  updated_at: dbTimestamp,
});

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

const PREFERENCE_COLUMNS =
  "id, profile_id, event_code, channel, is_enabled, quiet_hours_start, quiet_hours_end, " +
  "digest_frequency, updated_at";

function myPreferenceFilters(profileId: string): readonly Filter[] {
  return [eq("profile_id", profileId)];
}

/**
 * My own preference rows.
 *
 * Scoped in the QUERY, not left to RLS: the admin policy on this table is
 * `FOR ALL USING (app.is_admin())`, so an HR administrator opening their own
 * settings would otherwise read every employee's preferences.
 */
export async function fetchMyPreferences(
  profileId: string,
  signal?: AbortSignal,
): Promise<NotificationPreference[]> {
  return selectMany(NOTIFICATION_PREFERENCES_TABLE, notificationPreferenceSchema, {
    columns: PREFERENCE_COLUMNS,
    filters: myPreferenceFilters(profileId),
    order: [
      { column: "event_code", ascending: true },
      { column: "channel", ascending: true },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Switch one existing preference row on or off. */
export async function setPreferenceEnabled(
  preferenceId: string,
  isEnabled: boolean,
  signal?: AbortSignal,
): Promise<NotificationPreference> {
  return updateOne(
    NOTIFICATION_PREFERENCES_TABLE,
    notificationPreferenceSchema,
    { is_enabled: isEnabled },
    { id: preferenceId },
    { columns: PREFERENCE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Change the digest cadence of one existing preference row. */
export async function setPreferenceDigest(
  preferenceId: string,
  digest: DigestFrequency,
  signal?: AbortSignal,
): Promise<NotificationPreference> {
  return updateOne(
    NOTIFICATION_PREFERENCES_TABLE,
    notificationPreferenceSchema,
    { digest_frequency: digest },
    { id: preferenceId },
    { columns: PREFERENCE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}
