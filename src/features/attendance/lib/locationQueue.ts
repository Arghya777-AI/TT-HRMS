/**
 * locationQueue.ts — the fixes a phone is holding because it could not reach the server.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * "Even if the internet is not on, then we can access the GPS." That is true, and it is the
 * half worth keeping: a GPS receiver needs no network. What a phone with no signal cannot do
 * is SEND the reading — so every fix taken in a basement, a lift, a village or a dead zone was
 * simply lost.
 *
 * For staff working away from the venue that is exactly the wrong half to lose. The places with
 * no signal are the places somebody is least accounted for.
 *
 * ── WHY INDEXEDDB, NOT localStorage ─────────────────────────────────────────
 * `localStorage` is synchronous, string-only, and on iOS the first thing evicted under storage
 * pressure. A queued fix is small — about 120 bytes as JSON — but the writes happen while the
 * app is in use, and a synchronous main-thread write during a page interaction is a jank source
 * for no benefit. IndexedDB is async and survives eviction longer.
 *
 * ── ITS OWN DATABASE, NOT THE GATE'S ────────────────────────────────────────
 * `punchQueue.ts` owns `tt-gate`, on a kiosk tablet, versioned to its own schedule. This runs
 * in an EMPLOYEE's browser and has nothing to do with that device or that upgrade path. Sharing
 * the database would mean one feature's version bump could block the other's queue mid-outage.
 *
 * ── THE ORIGINAL INSTANT IS THE POINT ───────────────────────────────────────
 * A replayed fix keeps `capturedAt` from the moment the GPS answered. Re-dating it to the sync
 * would draw somebody teleporting to wherever they regained signal, every point at once — and
 * the shift window it is judged against would be the wrong one. The server records the arrival
 * separately in `synced_at`.
 */

const DB_NAME = "tt-hrms-location";
const DB_VERSION = 1;
const STORE = "ping-queue";

/**
 * The most fixes held at once.
 *
 * At one fix every five minutes, 2,000 is about a week offline — far beyond any real outage,
 * and roughly 240 KB, which no browser will evict a store for. Past that the OLDEST are
 * dropped: for knowing where somebody is, the newest fixes are the ones worth keeping, and a
 * queue that refused new writes would go blind exactly when it mattered.
 */
export const MAX_QUEUED = 2_000;

/**
 * Attempts before a fix is given up on.
 *
 * Three. The failures worth retrying are transient — a flapping link, a cold edge function —
 * and they clear in seconds. A fix the server keeps refusing is being refused for a reason
 * that will not change, and one bad row must never block the fixes behind it. Lower than the
 * gate's five because a location is far less precious than an attendance punch: losing one dot
 * costs a gap in a trail, losing a punch costs somebody's day.
 */
export const MAX_ATTEMPTS = 3;

export interface QueuedPing {
  /** Client-minted, and the dedup key: a replayed batch cannot double-record. */
  readonly id: string;
  /** When the GPS answered. NEVER the time it was sent. */
  readonly capturedAt: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
  readonly attempts: number;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private mode in some browsers exposes the object and throws on use.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // Ordered by capture, so a drain replays a journey in the order it happened and
        // trimming the oldest is one cursor walk rather than a full read.
        store.createIndex("capturedAt", "capturedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Every failure here resolves rather than throws: a trail is never worth breaking a page for. */
function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return new Promise((resolve) => {
    let request: IDBRequest<T> | null;
    try {
      request = run(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      resolve(null);
      return;
    }
    if (request === null) {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function enqueue(ping: Omit<QueuedPing, "attempts">): Promise<void> {
  const db = await open();
  if (db === null) return;
  await tx(db, "readwrite", (store) => store.put({ ...ping, attempts: 0 }));
  await trim(db);
}

/**
 * Oldest fixes dropped once the cap is passed.
 *
 * Deliberately the oldest. For "where is this person", the newest fix is the one that matters;
 * refusing new writes instead would make the queue go blind at exactly the moment it filled.
 */
async function trim(db: IDBDatabase): Promise<void> {
  const total = await tx<number>(db, "readonly", (store) => store.count());
  if (total === null || total <= MAX_QUEUED) return;
  const excess = total - MAX_QUEUED;
  await new Promise<void>((resolve) => {
    let removed = 0;
    let cursorRequest: IDBRequest<IDBCursorWithValue | null>;
    try {
      cursorRequest = db
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .index("capturedAt")
        .openCursor();
    } catch {
      resolve();
      return;
    }
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null || removed >= excess) {
        resolve();
        return;
      }
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    cursorRequest.onerror = () => resolve();
  });
}

/** The next fixes to try, oldest first, skipping any that have exhausted their attempts. */
export async function nextBatch(limit = 25): Promise<QueuedPing[]> {
  const db = await open();
  if (db === null) return [];
  const all = await tx<QueuedPing[]>(db, "readonly", (store) => store.getAll());
  if (all === null) return [];
  return all
    .filter((p) => p.attempts < MAX_ATTEMPTS)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(0, limit);
}

export async function acknowledge(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await open();
  if (db === null) return;
  for (const id of ids) await tx(db, "readwrite", (store) => store.delete(id));
}

/** One more failed attempt against each id. A fix past the cap stays, parked and countable. */
export async function recordFailure(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await open();
  if (db === null) return;
  for (const id of ids) {
    const existing = await tx<QueuedPing | undefined>(db, "readonly", (store) => store.get(id));
    if (existing === null || existing === undefined) continue;
    await tx(db, "readwrite", (store) =>
      store.put({ ...existing, attempts: existing.attempts + 1 }),
    );
  }
}

export interface QueueCounts {
  readonly waiting: number;
  readonly parked: number;
}

/** For a screen that wants to say "3 fixes waiting for signal" rather than stay silent. */
export async function counts(): Promise<QueueCounts> {
  const db = await open();
  if (db === null) return { waiting: 0, parked: 0 };
  const all = await tx<QueuedPing[]>(db, "readonly", (store) => store.getAll());
  if (all === null) return { waiting: 0, parked: 0 };
  return {
    waiting: all.filter((p) => p.attempts < MAX_ATTEMPTS).length,
    parked: all.filter((p) => p.attempts >= MAX_ATTEMPTS).length,
  };
}
