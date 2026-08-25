/**
 * punchQueue.ts — the scans a gate is holding because it could not reach the server.
 *
 * `kiosk-punch` has accepted a replay batch from the beginning: its own header calls the
 * shape "offline IndexedDB replay", every item carries its own event id so a resent batch
 * cannot double-count, and a replayed punch keeps its ORIGINAL capture instant rather than
 * the time it eventually arrived. The server half was built and the device half never was,
 * so a gate with no internet simply showed an error and lost the arrival. This is the
 * missing half.
 *
 * ── WHY INDEXEDDB AND NOT localStorage ───────────────────────────────────────
 * A queued punch is a 128-float descriptor plus metadata — roughly 1.5 KB as JSON. A
 * morning-long outage at a busy gate is a few hundred of them. `localStorage` is a
 * synchronous, string-only, ~5 MB store on the main thread: writing to it during a scan
 * loop competes with the camera, and on iOS it is the first thing evicted under pressure.
 * IndexedDB is asynchronous, structured, and survives eviction longer.
 *
 * ── WHY NO PHOTOGRAPH IS QUEUED ──────────────────────────────────────────────
 * `sendPunch` can carry a ~200 KB JPEG and an online punch does. A queued one deliberately
 * does not: two hundred queued scans would be 40 MB, which is where a browser starts
 * evicting the whole store — and losing the attendance to save the photograph is exactly
 * the wrong trade. The descriptor is what identifies the person; the photograph is
 * corroboration. The punch is recorded either way and the audit row simply has no image
 * for scans taken during an outage, which is honest and recoverable.
 *
 * ── WHY ATTEMPTS ARE COUNTED ─────────────────────────────────────────────────
 * A single item the server will never accept — a descriptor that fails validation after a
 * model change, say — would otherwise sit at the head of the queue and block every punch
 * behind it forever. After {@link MAX_ATTEMPTS} it is parked rather than retried, so one
 * poisoned scan cannot cost a day of attendance.
 */

const DB_NAME = "tt-gate";
/**
 * v2 adds the SYNC LOG — the record of what has already reached the server.
 *
 * The queue deletes an item once the server accepts it, which is correct: holding acknowledged
 * scans forever would grow without bound. But it left nothing to show afterwards. A gate that
 * ran through an outage could not tell anybody WHAT it had held or WHEN each item finally
 * arrived, and "it synced" is not something a venue should have to take on trust.
 *
 * The upgrade is additive — a new store beside the existing one, nothing rewritten — so a device
 * mid-outage keeps every queued punch through it.
 */
const DB_VERSION = 2;
const STORE = "punch-queue";
const SYNC_LOG = "sync-log";

/**
 * How many synced records are kept.
 *
 * 500 — several days of a busy gate, enough to answer "did yesterday's outage clear?", and
 * bounded so a terminal left running for a year does not fill its own storage with history
 * nobody will read. Oldest are dropped first."
 */
const SYNC_LOG_LIMIT = 500;

/**
 * Attempts before an item is parked.
 *
 * Five, because the failures worth retrying are transient — a flapping link, a 502 from a
 * cold edge function — and those clear in seconds. Anything still failing on a sixth try is
 * being refused for a reason that will not change by asking again.
 */
export const MAX_ATTEMPTS = 5;

/** One held scan. Mirrors `kiosk-punch`'s item shape, minus the photograph. */
export interface QueuedPunch {
  /** Primary key. Minted at capture, and the server's dedup key end to end. */
  clientEventId: string;
  /** Device wall clock at capture. Becomes `punched_at` on replay. */
  capturedAt: string;
  /** When it entered this queue — sent so the gap is visible in the audit row. */
  queuedAt: string;
  descriptor: number[];
  geo?: { latitude: number; longitude: number; accuracyMetres?: number };
  metrics?: {
    detectionScore: number;
    livenessScore: number;
    livenessModel?: string;
    framesAnalysed?: number;
  };
  /**
   * Who the DEVICE recognised at capture time, from its offline bundle.
   *
   * Display and audit only — it is shown in the on-device log and carried into the sync history
   * so an outage can be read back afterwards. It is NOT what the record is based on: the server
   * re-matches the descriptor when the queue drains.
   */
  localName?: string;
  /** The device's own match, offered to the server as a hint when its 1:N cannot decide. */
  localEmployeeId?: string;
  attempts: number;
  /** Set once the item has exhausted {@link MAX_ATTEMPTS}; never sent again. */
  parked?: true;
  /** Why it was parked, for the operator screen. */
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SYNC_LOG)) {
        // Keyed by event id, with an index on when it synced so the newest can be shown first.
        const log = db.createObjectStore(SYNC_LOG, { keyPath: "clientEventId" });
        log.createIndex("syncedAt", "syncedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by the event id, so enqueueing the same scan twice — a retried render, a
        // double-fired handler — overwrites rather than duplicating. Local idempotency
        // mirrors the server's.
        const store = db.createObjectStore(STORE, { keyPath: "clientEventId" });
        // Replay must be oldest-first: a queue flushed newest-first would record an
        // afternoon exit before the morning entry and the day would compute backwards.
        store.createIndex("capturedAt", "capturedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
  });
}

/**
 * Run one transaction and resolve when it COMMITS, not when the request succeeds.
 *
 * `request.onsuccess` fires before the transaction commits; resolving there and then
 * reporting "queued" to the person at the gate would be a lie if the commit then failed
 * on a full disk. `tx.oncomplete` is the only honest signal.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | { result: T },
  storeName: string = STORE,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const outcome = work(tx.objectStore(storeName));
      let value: T;
      if ("onsuccess" in outcome) {
        outcome.onsuccess = () => {
          value = outcome.result;
        };
        outcome.onerror = () => reject(outcome.error ?? new Error("request failed"));
      } else {
        value = outcome.result;
      }
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
    });
  } finally {
    db.close();
  }
}

/** Hold a scan. Overwrites any item with the same event id. */
export async function enqueue(punch: Omit<QueuedPunch, "attempts">): Promise<void> {
  await withStore("readwrite", (store) => store.put({ ...punch, attempts: 0 }));
}

/**
 * The next items to send, oldest capture first, excluding parked ones.
 *
 * `limit` defaults to 5 to match the batch size the server documents for a replay; it
 * accepts up to 25 but sending the documented size keeps a single failure cheap.
 */
export async function nextBatch(limit = 5): Promise<QueuedPunch[]> {
  const all = await withStore<QueuedPunch[]>("readonly", (store) =>
    store.index("capturedAt").getAll() as IDBRequest<QueuedPunch[]>,
  );
  return all.filter((item) => item.parked !== true).slice(0, Math.max(1, Math.min(25, limit)));
}

/** Drop items the server has accepted. */
export async function acknowledge(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withStore("readwrite", (store) => {
    for (const id of ids) store.delete(id);
    return { result: undefined };
  });
}

/**
 * Record a failed attempt, parking the item once it has had enough.
 *
 * Returns the ids that were parked, so the caller can surface them rather than letting a
 * scan disappear quietly.
 */
export async function recordFailure(
  ids: readonly string[],
  reason: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const current = await withStore<QueuedPunch[]>("readonly", (store) =>
    store.getAll() as IDBRequest<QueuedPunch[]>,
  );
  const parked: string[] = [];
  const updates = current
    .filter((item) => ids.includes(item.clientEventId) && item.parked !== true)
    .map((item) => {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        parked.push(item.clientEventId);
        return { ...item, attempts, parked: true as const, lastError: reason };
      }
      return { ...item, attempts, lastError: reason };
    });
  if (updates.length > 0) {
    await withStore("readwrite", (store) => {
      for (const item of updates) store.put(item);
      return { result: undefined };
    });
  }
  return parked;
}

export interface QueueCounts {
  /** Waiting to be sent. */
  pending: number;
  /** Given up on; needs a human. */
  parked: number;
}

export async function counts(): Promise<QueueCounts> {
  const all = await withStore<QueuedPunch[]>("readonly", (store) =>
    store.getAll() as IDBRequest<QueuedPunch[]>,
  );
  let pending = 0;
  let parked = 0;
  for (const item of all) {
    if (item.parked === true) parked += 1;
    else pending += 1;
  }
  return { pending, parked };
}

/**
 * Whether this browser can hold a queue at all.
 *
 * Checked rather than assumed: private browsing, a locked-down enterprise profile and some
 * embedded webviews expose `indexedDB` and then throw on open. A gate that cannot queue
 * must say so at installation, not discover it during the first outage.
 */
export async function isAvailable(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  try {
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Surviving the app being closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the browser to treat this device's storage as PERSISTENT.
 *
 * IndexedDB already survives the app being closed, a reload and a power cycle — that part was
 * never in doubt. What it does not survive by default is EVICTION: browsers clear "best-effort"
 * storage under disk pressure, and Safari additionally discards site data after seven days
 * without a visit for anything not installed to the home screen. A gate that queued a morning's
 * arrivals and was then left closed over a long weekend could lose them, and would never say so.
 *
 * `navigator.storage.persist()` moves the origin to "persistent", which browsers will not evict
 * automatically. It is granted without a prompt for an INSTALLED app, which is one more reason
 * the gate should be installed rather than left in a tab.
 *
 * Returns what actually happened, so the screen can say whether the guarantee is in force
 * rather than assuming it.
 */
export async function requestPersistentStorage(): Promise<"persisted" | "best-effort" | "unsupported"> {
  if (typeof navigator === "undefined" || navigator.storage === undefined) return "unsupported";
  try {
    if (typeof navigator.storage.persisted === "function" && (await navigator.storage.persisted())) {
      return "persisted";
    }
    if (typeof navigator.storage.persist !== "function") return "unsupported";
    return (await navigator.storage.persist()) ? "persisted" : "best-effort";
  } catch {
    return "unsupported";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The sync log — what has already reached the server, and when
// ─────────────────────────────────────────────────────────────────────────────

/** One scan that made it to the server. */
export interface SyncedPunch {
  clientEventId: string;
  /** When the person was actually at the gate. */
  capturedAt: string;
  /** When this device managed to hand it over. */
  syncedAt: string;
  /** Who the DEVICE thought it was, when it could tell. Display only, as ever. */
  localName?: string;
}

/**
 * Record that these ids reached the server, and trim the history.
 *
 * Called from the same place the items are dropped from the queue, so the two cannot disagree:
 * an item is either waiting or logged as sent, never both and never neither.
 */
export async function recordSynced(items: readonly SyncedPunch[]): Promise<void> {
  if (items.length === 0) return;
  try {
    await withStore(
      "readwrite",
      (store) => {
        for (const item of items) store.put(item);
        return { result: undefined };
      },
      SYNC_LOG,
    );
    // Trim oldest-first, outside the write above so a full store cannot block the write that
    // matters. The history is a convenience; the queue is the record.
    const all = await withStore<SyncedPunch[]>(
      "readonly",
      (store) => store.getAll() as IDBRequest<SyncedPunch[]>,
      SYNC_LOG,
    );
    if (all.length > SYNC_LOG_LIMIT) {
      const excess = all
        .sort((a, b) => a.syncedAt.localeCompare(b.syncedAt))
        .slice(0, all.length - SYNC_LOG_LIMIT)
        .map((s) => s.clientEventId);
      await withStore(
        "readwrite",
        (store) => {
          for (const id of excess) store.delete(id);
          return { result: undefined };
        },
        SYNC_LOG,
      );
    }
  } catch {
    // Losing the history must never cost a punch.
  }
}

/** The sync history, newest first. */
export async function syncedPunches(limit = 100): Promise<SyncedPunch[]> {
  try {
    const all = await withStore<SyncedPunch[]>(
      "readonly",
      (store) => store.getAll() as IDBRequest<SyncedPunch[]>,
      SYNC_LOG,
    );
    return all.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt)).slice(0, limit);
  } catch {
    return [];
  }
}

/** Everything still waiting, oldest first — including parked items, which `nextBatch` hides. */
export async function allQueued(): Promise<QueuedPunch[]> {
  try {
    const all = await withStore<QueuedPunch[]>("readonly", (store) =>
      store.index("capturedAt").getAll() as IDBRequest<QueuedPunch[]>,
    );
    return all;
  } catch {
    return [];
  }
}
