/**
 * display.ts — E-02's pure presentation vocabulary: enum → human label maps,
 * ordering and threshold bands. No component, no query, no arithmetic on a
 * business figure.
 *
 * Kept out of the component files so a status vocabulary can be unit-tested and
 * reused (and so fast refresh keeps working).
 */
import { civilDayOffset, isFutureInstant, istParts, istToday } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";
import type { Announcement, NotificationItem } from "./api/home.api";

// -----------------------------------------------------------------------------
// Region A — greeting
// -----------------------------------------------------------------------------

/** The IST hour decides the greeting: 05–11, 12–16, 17–21, else late night. */
export function greetingKeyForIstHour(hour: number): MessageKey {
  if (hour >= 5 && hour < 12) return "home.greeting.morning";
  if (hour >= 12 && hour < 17) return "home.greeting.afternoon";
  if (hour >= 17 && hour < 22) return "home.greeting.evening";
  return "home.greeting.night";
}

/** 'ARGHYA' → 'Arghya'; 'jean-luc' → 'Jean-Luc'. Display only (DR-14). */
export function toTitleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s'’-])([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

/** 'Good morning, Arghya' — greeting from the IST hour, never the browser's. */
export function greetingLine(firstName: string | null, nowMs: number): string {
  const { hour } = istParts(nowMs);
  const trimmed = firstName?.trim() ?? "";
  const name = trimmed === "" ? t("home.greeting.fallbackName") : toTitleCase(trimmed);
  return t(greetingKeyForIstHour(hour), { name });
}

/** Two initials for the avatar fallback while photos have no signed URL. */
export function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => p.charAt(0).toUpperCase()).join("");
  return letters === "" ? "?" : letters;
}

// Region B's day-status chip is NOT defined here on purpose: it comes from
// `@/features/attendance/display` (`dayStatusChip` / `displayStatus`), the same
// vocabulary `/me/attendance` renders. Two maps for one server enum is how a
// home tile and its detail screen start disagreeing (DR-29/DR-53).

// -----------------------------------------------------------------------------
// Region C — ranking the attention feed
// -----------------------------------------------------------------------------

export const MAX_ATTENTION_ITEMS = 5;

/** Highest first. The server sets `priority`; this only orders by it. */
const PRIORITY_RANK: Record<NotificationItem["priority"], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export type AttentionBadgeVariant = "danger" | "warning" | "info" | "neutral";

const PRIORITY_BADGE_KEYS: Record<
  NotificationItem["priority"],
  { variant: AttentionBadgeVariant; labelKey: MessageKey }
> = {
  critical: { variant: "danger", labelKey: "home.attention.priority.critical" },
  high: { variant: "warning", labelKey: "home.attention.priority.high" },
  normal: { variant: "info", labelKey: "home.attention.priority.normal" },
  low: { variant: "neutral", labelKey: "home.attention.priority.low" },
};

/** Severity badge for an attention row — the server's `priority`, in words. */
export function priorityBadge(priority: NotificationItem["priority"]): {
  variant: AttentionBadgeVariant;
  label: string;
} {
  const entry = PRIORITY_BADGE_KEYS[priority];
  return { variant: entry.variant, label: t(entry.labelKey) };
}

/**
 * Unexpired items, ranked by the server's own severity then oldest first, capped
 * at five (spec E-02 Region C: `severity DESC, due_at ASC`, max 5). Nothing is
 * invented and nothing is re-scored.
 */
export function rankAttentionItems(
  items: readonly NotificationItem[],
  nowMs: number,
): NotificationItem[] {
  return [...items]
    .filter((n) => n.expires_at === null || isFutureInstant(n.expires_at, nowMs))
    .sort((a, b) => {
      const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (byPriority !== 0) return byPriority;
      return a.recorded_at.localeCompare(b.recorded_at);
    })
    .slice(0, MAX_ATTENTION_ITEMS);
}

/** Only in-app routes are followed; anything else is not rendered as a link. */
export function internalLink(deepLink: string | null): string | null {
  if (deepLink === null) return null;
  return deepLink.startsWith("/") && !deepLink.startsWith("//") ? deepLink : null;
}

// -----------------------------------------------------------------------------
// Region I — announcement emphasis
// -----------------------------------------------------------------------------

/**
 * A notice's own `priority`, in words. `normal`/`low` get no badge at all —
 * chrome proportional to the content (DR-46).
 */
export function announcementBadge(
  priority: Announcement["priority"],
): { variant: AttentionBadgeVariant; label: string } | null {
  if (priority === "critical") {
    return { variant: "danger", label: t("home.news.priority.critical") };
  }
  if (priority === "high") {
    return { variant: "warning", label: t("home.news.priority.high") };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Region F — comp-off expiry bands
// -----------------------------------------------------------------------------

export type ExpiryTone = "neutral" | "warn" | "danger";

/**
 * Amber ≤15 days, red ≤5 days (spec E-02 Region F). A calendar comparison
 * against the server's `nearest_expiry` — the DATE on screen is always that
 * column, never a client-side countdown.
 */
export function expiryTone(nearestExpiry: string | null, today: string = istToday()): ExpiryTone {
  if (nearestExpiry === null) return "neutral";
  const days = civilDayOffset(today, nearestExpiry);
  if (days <= 5) return "danger";
  if (days <= 15) return "warn";
  return "neutral";
}
