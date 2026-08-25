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
import {
  acknowledge,
  counts,
  nextBatch,
  recordFailure,
  recordSynced,
  type QueuedPunch,
} from "./punchQueue";
import { nowInstantIso } from "@/lib/datetime";

/**
 * Items per request. 25 — the maximum `kiosk-punch` accepts.
 *
 * It was 5, and that was the difference between a queue draining in seconds and in minutes: 200
 * held punches meant 40 round trips, each with its own HMAC, TLS and 1:N latency. The server has
 * always taken 25 (`MAX_BATCH_ITEMS`), and 25 descriptors is roughly 40 KB against a 2 MB body
 * limit, so nothing about the larger batch is close to a boundary.
 *
 * Raising it was only safe once replays got their own rate-limit bucket. Against the live
 * 40/minute allowance a 25-item batch sent to a near-empty bucket was refused WHOLE, so the
 * queue made no progress at all — bigger batches made it slower. The two changes go together.
 */
const BATCH_SIZE = 25;

/**
 * Batches per flush.
 *
 * Bounded so a long outage does not turn one reconnection into an upload that never ends.
 * 40 × 25 is a thousand held scans in a single flush — more than a gate accumulates in a day —
 * and whatever is left is picked up by the next trigger, with the queue durable in the meantime.
 *
 * The bound is on ROUND TRIPS, not on time: each one only continues while the previous made
 * progress, so an empty queue costs one request and a full one is not artificially throttled.
 */
const MAX_BATCHES_PER_FLUSH = 40;

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
  /**
   * True when the server refused for allowance rather than for content.
   *
   * Distinct from `offline` on purpose: the network is fine and the same bytes will succeed
   * shortly, so the caller should retry soon and must not tell anybody the gate is disconnected.
   */
  rateLimited: boolean;
}

function toWireItem(item: QueuedPunch): PunchBatchItem {
  return {
    clientEventId: item.clientEventId,
    capturedAt: item.capturedAt,
    queuedAt: item.queuedAt,
    descriptor: item.descriptor,
    ...(item.geo ? { geo: item.geo } : {}),
    ...(item.metrics ? { metrics: item.metrics } : {}),
    // The device's offline identification, offered to the server as a tie-breaker only.
    ...(item.localEmployeeId !== undefined ? { localEmployeeId: item.localEmployeeId } : {}),
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
    return { sent: 0, refused: 0, parked: [], pending, offline: false, rateLimited: false, skipped: true };
  }
  inFlight = true;

  let sent = 0;
  let refused = 0;
  let offline = false;
  let rateLimited = false;
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
        /*
          429 is neither offline nor a bad scan: the device has run out of allowance and the
          same bytes will succeed shortly. It is called out because it must NOT set `offline` —
          a gate that showed itself as disconnected while its queue was merely throttled would
          send the person at the door a false story about the network.
        */
        rateLimited = result.error.status === 429;
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
        /*
          The history is written BEFORE the queue entry is dropped.

          Order matters: acknowledging first and crashing before the log wrote would lose the
          only trace that the punch ever existed on this device. This way the worst case is a
          record that says "sent" for something the queue still holds — which the next flush
          resolves harmlessly, because the server dedups on the event id.
        */
        const syncedAt = nowInstantIso();
        await recordSynced(
          batch
            .filter((item) => done.includes(item.clientEventId))
            .map((item) => ({
              clientEventId: item.clientEventId,
              capturedAt: item.capturedAt,
              syncedAt,
              ...(item.localName !== undefined ? { localName: item.localName } : {}),
            })),
        );
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
  return { sent, refused, parked, pending, offline, rateLimited, skipped: false };
}

/** Whether a flush is currently running, for the screen's own indicators. */
export function isFlushing(): boolean {
  return inFlight;
}
