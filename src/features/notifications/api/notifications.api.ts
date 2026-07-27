/**
 * notifications.api.ts — the E-16 reads and the two writes an employee owns.
 *
 * `public.notifications` (migration 027) is real, deployed and LIVE: the cron
 * jobs write into it (KIOSK_OFFLINE, PUNCH_MISSING_OUT rows exist on the
 * project right now), and it is quarterly-partitioned on `recorded_at`.
 *
 * Four facts about it decide the shape of this module:
 *
 *  1. RLS lets you see a row addressed to your PROFILE or to your EMPLOYEE row —
 *     but the admin policy also lets an admin see EVERYONE's rows. So `/me`
 *     cannot rely on RLS for scoping: an HR admin would open their own feed and
 *     read the whole company's. Every read here therefore filters
 *     `profile_id = <me>` explicitly. Verified live: 0 of the rows on the project
 *     have a NULL `profile_id`, so this filter loses nothing — and
 *     `countEmployeeOnlyUnlisted` counts anything it WOULD lose, so the screen can
 *     say so instead of quietly dropping it.
 *  2. The query layer's keyset cursor refuses a value containing '.', because a
 *     '.' would change the meaning of a PostgREST `or=` predicate. A
 *     `recorded_at` timestamp has fractional seconds, so keyset paging on this
 *     table is impossible through the sanctioned helper. The feed is therefore a
 *     capped newest-first read (`FEED_LIMIT`) next to a server COUNT of the whole
 *     filtered set — when the count exceeds what was loaded, the screen says the
 *     rest is older than what is shown rather than pretending it is all of it.
 *  3. `authenticated` holds `GRANT UPDATE (read_at, dismissed_at)` and nothing
 *     else, so "mark as read" is the only write. The table is deliberately NOT in
 *     the audit trigger set (038), so no reason is required — `updateOne` from
 *     the write layer is the right helper.
 *  4. `notification_templates` — the catalogue that says which event codes exist
 *     and which ones are transactional — is admin-only (P8). An employee can
 *     read their own notifications but not the vocabulary behind them, which is
 *     why nothing here maps an `event_code` to a friendly template name.
 */
import { z } from "zod";
import {
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isMutationErrorOfKind,
  isNotNull,
  isNull,
  selectCount,
  selectMany,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { updateOne } from "@/shared/api/write";
import { nowInstantIso } from "@/lib/datetime";

export const NOTIFICATIONS_TABLE = "notifications";

/**
 * Newest-first cap. A year of retention for one employee is tens of rows, not
 * thousands; the cap exists so a chatty account cannot pull an unbounded page,
 * and the count beside it makes the cap visible when it bites.
 */
export const FEED_LIMIT = 200;

/** `public.notification_channel` (migration 003). */
export const notificationChannelSchema = z.enum([
  "in_app",
  "email",
  "sms",
  "whatsapp",
  "push",
  "kiosk_display",
]);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationChannelValues: readonly NotificationChannel[] =
  notificationChannelSchema.options;

/** `public.notification_status` (migration 003). */
export const notificationStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "failed",
  "bounced",
  "suppressed",
  "cancelled",
]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/** `ck_notifications__priority` (migration 027). */
export const notificationPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

export const notificationPriorityValues: readonly NotificationPriority[] =
  notificationPrioritySchema.options;

export const notificationSchema = z.object({
  id: dbUuid,
  employee_id: dbUuidNullable,
  profile_id: dbUuidNullable,
  event_code: z.string(),
  channel: notificationChannelSchema,
  title: z.string(),
  body: z.string().nullable(),
  deep_link: z.string().nullable(),
  priority: notificationPrioritySchema,
  status: notificationStatusSchema,
  read_at: dbTimestampNullable,
  dismissed_at: dbTimestampNullable,
  recorded_at: dbTimestamp,
  expires_at: dbTimestampNullable,
});

export type Notification = z.infer<typeof notificationSchema>;

const NOTIFICATION_COLUMNS =
  "id, employee_id, profile_id, event_code, channel, title, body, deep_link, priority, " +
  "status, read_at, dismissed_at, recorded_at, expires_at";

export type ReadFilter = "all" | "unread" | "read";

export interface FeedFilters {
  readonly read?: ReadFilter;
  readonly channel?: NotificationChannel;
  readonly priority?: NotificationPriority;
}

/**
 * The ONE filter builder. The feed read and every count of it are built from
 * this, so a tile can never be the cardinality of a different row set than the
 * list under it.
 */
export function feedFilters(profileId: string, filters: FeedFilters = {}): readonly Filter[] {
  const out: Filter[] = [eq("profile_id", profileId)];
  if (filters.read === "unread") out.push(isNull("read_at"));
  if (filters.read === "read") out.push(isNotNull("read_at"));
  if (filters.channel !== undefined) out.push(eq("channel", filters.channel));
  if (filters.priority !== undefined) out.push(eq("priority", filters.priority));
  return out;
}

/** Newest first, capped at `FEED_LIMIT` — see note 2 in the module header. */
export async function fetchNotifications(
  profileId: string,
  filters: FeedFilters = {},
  signal?: AbortSignal,
): Promise<Notification[]> {
  return selectMany(NOTIFICATIONS_TABLE, notificationSchema, {
    columns: NOTIFICATION_COLUMNS,
    filters: feedFilters(profileId, filters),
    order: [
      { column: "recorded_at", ascending: false },
      { column: "id", ascending: false },
    ],
    limit: FEED_LIMIT,
    ...(signal ? { signal } : {}),
  });
}

/** `count=exact` over the SAME filters as the feed read. */
export async function countNotifications(
  profileId: string,
  filters: FeedFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    NOTIFICATIONS_TABLE,
    feedFilters(profileId, filters),
    signal ? { signal } : {},
  );
}

export async function countUnread(profileId: string, signal?: AbortSignal): Promise<number> {
  return countNotifications(profileId, { read: "unread" }, signal);
}

/**
 * Rows addressed to me by EMPLOYEE id with no profile id — the ones the
 * profile-scoped filter cannot fetch (module header note 1). Live this is 0; the
 * screen surfaces it rather than assuming it always will be.
 */
export async function countEmployeeOnlyUnlisted(
  employeeId: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(
    NOTIFICATIONS_TABLE,
    [eq("employee_id", employeeId), isNull("profile_id")],
    signal ? { signal } : {},
  );
}

/** Per-channel counts, each one a server COUNT. Used by E-18.1. */
export async function countByChannel(
  profileId: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<NotificationChannel, number>>> {
  const entries = await Promise.all(
    notificationChannelValues.map(async (channel) => {
      const n = await countNotifications(profileId, { channel }, signal);
      return [channel, n] as const;
    }),
  );
  const out: Record<NotificationChannel, number> = {
    in_app: 0,
    email: 0,
    sms: 0,
    whatsapp: 0,
    push: 0,
    kiosk_display: 0,
  };
  for (const [channel, n] of entries) out[channel] = n;
  return out;
}

/**
 * Mark ONE notification read. `read_at` is one of the two columns the
 * `authenticated` role may write here; RLS confines the statement to my own row
 * regardless of the id passed.
 */
export async function markNotificationRead(
  notificationId: string,
  signal?: AbortSignal,
): Promise<Notification> {
  return updateOne(
    NOTIFICATIONS_TABLE,
    notificationSchema,
    { read_at: nowInstantIso() },
    { id: notificationId },
    { columns: NOTIFICATION_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/**
 * The reason attached to the bulk mark-read.
 *
 * `notifications` is deliberately outside the audit trigger set, so nothing
 * records this sentence — but `updateRow` is the only sanctioned helper that
 * takes a FILTER (rather than a primary key) and it requires one, so the honest
 * thing is a truthful sentence rather than a per-row request storm.
 */
const MARK_ALL_REASON = "Employee marked their own notification feed as read.";

/**
 * Mark every unread notification of mine read in ONE statement.
 *
 * Returns null when there was nothing unread: PostgREST answers an empty
 * representation, which `updateRow` correctly reports as `not_found`, and "you
 * had nothing to clear" is not an error worth showing.
 */
export async function markAllNotificationsRead(
  profileId: string,
  signal?: AbortSignal,
): Promise<Notification | null> {
  try {
    return await updateRow(
      NOTIFICATIONS_TABLE,
      [eq("profile_id", profileId), isNull("read_at")],
      { read_at: nowInstantIso() },
      notificationSchema,
      {
        reason: MARK_ALL_REASON,
        columns: NOTIFICATION_COLUMNS,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (isMutationErrorOfKind(error, "not_found")) return null;
    throw error;
  }
}

/** Undo — the same column, back to NULL. */
export async function markNotificationUnread(
  notificationId: string,
  signal?: AbortSignal,
): Promise<Notification> {
  return updateOne(
    NOTIFICATIONS_TABLE,
    notificationSchema,
    { read_at: null },
    { id: notificationId },
    { columns: NOTIFICATION_COLUMNS, ...(signal ? { signal } : {}) },
  );
}
