/**
 * punchSync.ts — drain the offline queue when the gate can reach the server again.
 *
 * ── WHOLE-REQUEST FAILURE IS NOT THE ITEMS' FAULT ────────────────────────────
 * The single most important distinction in this file. If the POST itself fails — no
 * network, a 502, a timeout — nothing is known about any individual scan, so no attempt is
 * counted against any of them and the flush simply stops. Counting a failed attempt there
 * would burn all five of an item's lives on five router reboots and park a perfectly good
 * arrival.
 *
 * An attempt is counted only when the server answered 200 and named that specific item as
 * refused. That is the only evidence that the item itself is the problem.
 *
 * ── ONE FLUSH AT A TIME ──────────────────────────────────────────────────────
 * The `online` event, the visibility change, the periodic timer and a successful live punch
 * can all decide to flush within the same second. Two concurrent flushes would read the
 * same head of the queue and post the same scans twice. The server would dedup them —
 * every item carries its own event id — but it would also log two attempts for one arrival
 * and make the audit trail read as though somebody scanned twice. The in-flight guard is
 * module-scoped because there is exactly one queue per browser.
 *
 * ── OLDEST FIRST, ALWAYS ─────────────────────────────────────────────────────
 * `nextBatch` orders by capture time. A queue flushed newest-first would record an
 * afternoon exit before the morning entry, and the attendance engine would compute the day
 * from a sequence that never happened.
 */
import {
  sendPunchBatch,
  type KioskDeviceState,
  type PunchBatchItem,
} from "./deviceAuth";
import { acknowledge, counts, nextBatch, recordFailure, type QueuedPunch } from "./punchQueue";

/** Items per request. Five is the size `kiosk-punch` documents for a replay. */
const BATCH_SIZE = 5;

/**
 * Batches per flush.
 *
 * Bounded so a long outage does not turn one reconnection into a minutes-long upload that
 * blocks the scan loop. Whatever is left is picked up by the next trigger, and the queue is
 * durable in the meantime.
 */
const MAX_BATCHES_PER_FLUSH = 10;

/** Exactly one flush in flight per browser — see the header. */
let inFlight = false;

export interface FlushOutcome {
  /** Scans the server accepted and that have been dropped from the queue. */
  sent: number;
  /** Scans the server named as refused; each has had an attempt counted. */
  refused: number;
  /** Ids that exhausted their attempts during this flush and now need a human. */
  parked: string[];
  /** Still waiting after this flush. */
  pending: number;
  /**
   * True when the flush stopped because the server could not be reached at all, as
   * distinct from stopping because the queue was empty. The caller uses this to keep the
   * LIVE lamp honest.
   */
  offline: boolean;
  /** True when another flush was already running and this call did nothing. */
  skipped: boolean;
}

function toWireItem(item: QueuedPunch): PunchBatchItem {
  return {
    clientEventId: item.clientEventId,
    capturedAt: item.capturedAt,
    queuedAt: item.queuedAt,
    descriptor: item.descriptor,
    ...(item.geo ? { geo: item.geo } : {}),
    ...(item.metrics ? { metrics: item.metrics } : {}),
  };
}

/**
 * Send what is held, oldest first, until the queue is empty or the server stops answering.
 *
 * Never throws. A gate whose sync threw would take the scan loop down with it, and a
 * terminal that cannot record attendance is a worse outcome than one that cannot sync.
 */
export async function flushQueue(state: KioskDeviceState): Promise<FlushOutcome> {
  if (inFlight) {
    const { pending } = await counts().catch(() => ({ pending: 0, parked: 0 }));
    return { sent: 0, refused: 0, parked: [], pending, offline: false, skipped: true };
  }
  inFlight = true;

  let sent = 0;
  let refused = 0;
  let offline = false;
  const parked: string[] = [];

  try {
    for (let round = 0; round < MAX_BATCHES_PER_FLUSH; round += 1) {
      const batch = await nextBatch(BATCH_SIZE).catch((): QueuedPunch[] => []);
      if (batch.length === 0) break;

      const result = await sendPunchBatch(state, batch.map(toWireItem));

      if (!result.ok) {
        /*
          The request failed as a whole. Nothing is known about any item in it, so nothing
          is charged against them — see the header. `status === 0` is this client's own
          marker for "could not reach the server at all"; a 5xx is the server failing rather
          than the scan being wrong, and both mean try again later.
        */
        offline = result.error.status === 0 || result.error.status >= 500;
        break;
      }

      /*
        Positional pairing, which is the documented contract: `results[i]` belongs to
        `batch[i]` and the ids are not echoed back. If the server ever returns a different
        length, treat the unmatched tail as unanswered rather than guessing — an item wrongly
        acknowledged is an arrival silently deleted.
      */
      const results = result.data.results ?? [];
      const done: string[] = [];
      const failed: string[] = [];
      batch.forEach((item, index) => {
        const answer = results[index];
        if (answer === undefined) return;
        if (answer.error === undefined) done.push(item.clientEventId);
        else failed.push(item.clientEventId);
      });

      if (done.length > 0) {
        await acknowledge(done).catch(() => undefined);
        sent += done.length;
      }
      if (failed.length > 0) {
        const nowParked = await recordFailure(failed, "refused on replay").catch(
          (): string[] => [],
        );
        parked.push(...nowParked);
        refused += failed.length;
      }

      // Nothing moved and nothing was charged: the queue head is stuck. Stop rather than
      // spinning through the remaining rounds against the same items.
      if (done.length === 0 && failed.length === 0) break;
    }
  } finally {
    inFlight = false;
  }

  const { pending } = await counts().catch(() => ({ pending: 0, parked: 0 }));
  return { sent, refused, parked, pending, offline, skipped: false };
}

/** Whether a flush is currently running, for the screen's own indicators. */
export function isFlushing(): boolean {
  return inFlight;
}
