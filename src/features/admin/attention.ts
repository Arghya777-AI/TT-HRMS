/**
 * attention.ts — "6 need your attention", and what the six are.
 *
 * ── WHY THIS IS NOT THE NOTIFICATION FEED ────────────────────────────────────
 * The obvious build is "count unread notifications and show that". Measured against the live
 * table on 5 Sep 2026, that number is worse than useless:
 *
 *     Suraj Kumar      17,890 unread        Vinod Maurya      8,997
 *     Preethi Machani   8,250 unread        Ranjeeth Pai M    4,820
 *
 * 39,572 of the unread rows are `KIOSK_OFFLINE`. An administrator logging in to "you have
 * 17,890 notifications" learns nothing and stops looking, which is the state the console was
 * already in. So this counts QUEUES THAT WAIT ON A PERSON instead — things with a verb: three
 * approvals to decide, seven tickets to answer. Small, true, and every one of them opens.
 *
 * The notification feed keeps its own bell and its own count. It is a log; this is a to-do
 * list, and conflating the two is what made the log unreadable.
 *
 * ── WHY THE ORDER IS FIXED AND NOT BY SIZE ───────────────────────────────────
 * Sorting by count would put "31 face captures outstanding" above "3 approvals waiting on
 * you", and the approvals are the ones with an SLA and somebody waiting on the other end. The
 * order is by who is blocked: decisions routed to this administrator first, then people
 * waiting on the venue, then housekeeping.
 *
 * ── A FAILED COUNT IS NOT A ZERO ─────────────────────────────────────────────
 * `null` means "could not be read" and the row is omitted rather than shown as 0. Zero is a
 * claim — "you are up to date" — and the console must never make it on a failed request. Same
 * rule as the KPI tiles, which show `—` for exactly this reason.
 */
import type { MessageKey } from "@/shared/i18n/en";

/** How loudly a row asks. `act` is the red one: somebody is blocked on this administrator. */
export type AttentionTone = "act" | "chase" | "tidy";

export interface AttentionSource {
  readonly key: AttentionKey;
  /** `null` when the count could not be read — the row is dropped, never shown as zero. */
  readonly count: number | null;
  readonly href: string;
}

export type AttentionKey =
  | "approvals"
  | "alerts"
  | "punchReview"
  | "faceCaptures"
  | "helpdesk"
  | "faceAsks"
  | "documents";

export interface AttentionItem {
  readonly key: AttentionKey;
  readonly count: number;
  readonly href: string;
  readonly tone: AttentionTone;
  readonly labelKey: MessageKey;
}

/**
 * The fixed order, with each row's tone and wording. Adding a queue means adding a line here
 * and nothing else — the banner, the popup and the count all read this one list.
 */
const ORDER: readonly {
  readonly key: AttentionKey;
  readonly tone: AttentionTone;
  readonly labelKey: MessageKey;
}[] = [
  { key: "approvals", tone: "act", labelKey: "admin.attention.approvals" },
  { key: "alerts", tone: "act", labelKey: "admin.attention.alerts" },
  { key: "punchReview", tone: "act", labelKey: "admin.attention.punchReview" },
  { key: "faceCaptures", tone: "act", labelKey: "admin.attention.faceCaptures" },
  { key: "helpdesk", tone: "chase", labelKey: "admin.attention.helpdesk" },
  { key: "faceAsks", tone: "chase", labelKey: "admin.attention.faceAsks" },
  { key: "documents", tone: "tidy", labelKey: "admin.attention.documents" },
];

export interface AttentionSummary {
  /** Every row with something in it, in the fixed order above. Nothing is hidden. */
  readonly items: readonly AttentionItem[];
  /** Sum of the `act` rows — work that is blocked on this administrator. */
  readonly actionCount: number;
  /** Sum of the `chase` and `tidy` rows — real, but nobody is waiting on a decision. */
  readonly followUpCount: number;
  /** True when anything is blocked on them. The bar is red for this and nothing else. */
  readonly urgent: boolean;
  /**
   * THE NUMBER IN THE SENTENCE, and it is deliberately not `actionCount + followUpCount`.
   *
   * Measured live on 5 Sep 2026 the venue had 1 approval, 3 captures to decide, 7 open
   * tickets and 31 people who had not yet been to the camera. Summing those says "42 need
   * your attention", a number dominated by a backlog that will never be zero — and a headline
   * that is never zero is one nobody reads, which is how the notification feed reached 17,890
   * unread. Four things actually need this administrator today, and that is what it says.
   *
   * The follow-up rows are still listed underneath with their own counts. Nothing is hidden;
   * the headline just refuses to inflate itself with work nobody is blocked on.
   */
  readonly headline: number;
}

export function summariseAttention(sources: readonly AttentionSource[]): AttentionSummary {
  const bySource = new Map(sources.map((s) => [s.key, s]));
  const items: AttentionItem[] = [];

  for (const row of ORDER) {
    const source = bySource.get(row.key);
    if (source === undefined) continue;
    // Unreadable, or nothing to do. Neither earns a line.
    if (source.count === null || source.count <= 0) continue;
    items.push({
      key: row.key,
      count: source.count,
      href: source.href,
      tone: row.tone,
      labelKey: row.labelKey,
    });
  }

  /* Both sums are over DISPLAYED rows only. A count that included a row the banner then hid
     would send somebody hunting for a fourth thing that was never there. */
  const sum = (tones: readonly AttentionTone[]): number =>
    items.filter((i) => tones.includes(i.tone)).reduce((n, i) => n + i.count, 0);

  const actionCount = sum(["act"]);
  const followUpCount = sum(["chase", "tidy"]);

  return {
    items,
    actionCount,
    followUpCount,
    urgent: actionCount > 0,
    headline: actionCount > 0 ? actionCount : followUpCount,
  };
}

/**
 * What the login popup shows, shortest useful form.
 *
 * A popup is read in about a second, so it takes the top few rows and says how many were left
 * over. The banner underneath carries the full list — this is a nudge towards it, not a
 * replacement for it.
 */
export const POPUP_ROWS = 3;

export function popupItems(summary: AttentionSummary): {
  readonly shown: readonly AttentionItem[];
  readonly more: number;
} {
  const shown = summary.items.slice(0, POPUP_ROWS);
  return { shown, more: Math.max(0, summary.items.length - shown.length) };
}

/**
 * The one sentence, chosen once.
 *
 * The bar and the popup both say it, and they said it from two copies of the same ternary
 * until this existed — which is how "6 need your action" and "6 need your attention" end up
 * on the same screen.
 */
export function headlineKey(summary: AttentionSummary): MessageKey {
  if (summary.urgent) {
    return summary.headline === 1 ? "admin.attention.titleOne" : "admin.attention.title";
  }
  return summary.headline === 1
    ? "admin.attention.followUpTitleOne"
    : "admin.attention.followUpTitle";
}
