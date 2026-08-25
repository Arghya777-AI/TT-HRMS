/**
 * faceBundle.ts — the enrolled faces, held on the device so the gate works with no internet.
 *
 * ── WHAT IT BUYS ─────────────────────────────────────────────────────────────
 * Before this, an offline scan was recorded blind: the tablet held a descriptor it could not
 * interpret, said "recorded" without knowing who to, and the on-screen log stayed empty for
 * the whole outage. Nobody could verify anything at the time or afterwards. With a bundle the
 * terminal names the person, logs the scan, and still queues the punch.
 *
 * ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
 * A LOCAL MATCH IS FOR THE SCREEN, NEVER FOR THE RECORD.
 *
 * The queued punch keeps carrying its descriptor, and `kiosk-punch` re-runs the 1:N against
 * live templates when the queue drains. What this file produces is a name to show and a row to
 * log — it never becomes the identity on `attendance_punches`.
 *
 * That is not timidity. A device's copy is stale by construction: somebody re-enrols, somebody
 * withdraws consent, somebody leaves. A tablet that could assert identity from a week-old
 * bundle would write attendance for a person the server would now refuse to match. So the
 * device SHOWS a name and never ASSERTS one, and if the server later disagrees then the record
 * is right and only a screen was briefly wrong.
 *
 * ── WHY A SEPARATE DATABASE FROM THE QUEUE ───────────────────────────────────
 * `punchQueue` owns `tt-gate`, and that store holds attendance that exists nowhere else until
 * it syncs. Adding a store to it means an `onupgradeneeded` migration on every terminal, and a
 * failed upgrade would take the queue down with it. This bundle is a CACHE — losing it costs a
 * re-download — so it lives in its own database where it cannot endanger anything.
 *
 * ── EXPIRY IS A CONTROL, NOT HOUSEKEEPING ────────────────────────────────────
 * The server stamps `expiresAt`, and past it this module refuses to match. It is the only lever
 * that bounds how long a withdrawn consent or a revoked device keeps being honoured on hardware
 * nobody can physically reach. A gate that has been offline longer than the window stops naming
 * people and says so — it does not keep going on data it can no longer vouch for.
 */
import { nowInstantIso } from "@/lib/datetime";
import { deviceCall, type KioskDeviceState } from "./deviceAuth";

const DB_NAME = "tt-gate-faces";
const DB_VERSION = 1;
const STORE = "bundle";
/** One row, one key: the whole bundle is replaced atomically or not at all. */
const RECORD_KEY = "current";

/** One person and every sample of their current enrolment. */
export interface BundlePerson {
  employeeId: string;
  employeeCode: string;
  displayName: string;
  employmentStatus: string;
  modelVersion: string;
  /**
   * Float32Array, not number[].
   *
   * ~365 samples × 128 values. As JS numbers that is roughly 375 KB of boxed doubles that the
   * matcher walks on every frame; as Float32Array it is 187 KB of contiguous memory and the
   * inner loop stays in one type. On a 1 GB iPad that difference is the difference between a
   * scan feeling instant and feeling slow.
   */
  descriptors: Float32Array[];
}

export interface FaceBundle {
  version: string;
  /** ISO instant past which this must not be used to name anybody. */
  expiresAt: string;
  descriptorDim: number;
  people: BundlePerson[];
  /** When this device stored it, for the diagnostics line. */
  fetchedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
  });
}

/**
 * Resolve when the transaction COMMITS, not when the request succeeds.
 *
 * `onsuccess` fires before the commit, and reporting a stored bundle that then failed to commit
 * would leave a gate believing it can work offline when it cannot.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | { result: T },
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const outcome = work(tx.objectStore(STORE));
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

/** What the server sends. Descriptors arrive as plain arrays and are packed on the way in. */
interface BundleResponse {
  unchanged?: boolean;
  version?: string;
  expiresAt?: string;
  descriptorDim?: number;
  count?: number;
  employees?: {
    employeeId: string;
    employeeCode: string;
    displayName: string;
    employmentStatus: string;
    modelVersion: string;
    descriptors: number[][];
  }[];
}

/** The bundle this device holds, or null. Never throws. */
export async function loadBundle(): Promise<FaceBundle | null> {
  try {
    const stored = await withStore<FaceBundle | undefined>("readonly", (store) =>
      store.get(RECORD_KEY) as IDBRequest<FaceBundle | undefined>,
    );
    if (stored === undefined) return null;
    /*
      Float32Array survives structured clone, but a bundle written by an older build — or read
      from a store somebody has poked at — may hold plain arrays. Re-pack rather than trust, so
      the matcher's inner loop can assume one type.
    */
    return {
      ...stored,
      people: stored.people.map((person) => ({
        ...person,
        descriptors: person.descriptors.map((d) =>
          d instanceof Float32Array ? d : new Float32Array(d as unknown as number[]),
        ),
      })),
    };
  } catch {
    return null;
  }
}

async function saveBundle(bundle: FaceBundle): Promise<void> {
  await withStore("readwrite", (store) => store.put(bundle, RECORD_KEY));
}

/** Drop it — used when a device is being handed on or re-paired. */
export async function clearBundle(): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(RECORD_KEY));
  } catch {
    // A cache that will not clear is untidy, not broken.
  }
}

/** Whether this bundle may still be used to name somebody. */
export function bundleUsable(bundle: FaceBundle | null, now = Date.now()): boolean {
  if (bundle === null || bundle.people.length === 0) return false;
  const expires = Date.parse(bundle.expiresAt);
  // An unparseable expiry is treated as expired. Failing closed is the only safe direction for
  // a control whose whole job is to stop stale biometric data being honoured.
  if (!Number.isFinite(expires)) return false;
  return now < expires;
}

export interface RefreshOutcome {
  kind: "updated" | "unchanged" | "offline" | "refused";
  bundle: FaceBundle | null;
  /** Present on "refused" — the server's own machine code, for the diagnostics line. */
  code?: string;
}

/**
 * Ask the server for the bundle, sending the version already held so the usual answer is small.
 *
 * Never throws. A gate that could not refresh must keep scanning on what it has — the bundle is
 * an enhancement to an offline scan, and failing to update it is not a reason to stop recording
 * attendance.
 */
export async function refreshBundle(state: KioskDeviceState): Promise<RefreshOutcome> {
  const existing = await loadBundle();

  const result = await deviceCall<BundleResponse>(state, "kiosk-face-bundle", {
    device_id: state.deviceId,
    ...(existing !== null ? { have_version: existing.version } : {}),
  });

  if (!result.ok) {
    // status 0 is this client's marker for "could not reach the server at all".
    if (result.error.status === 0) return { kind: "offline", bundle: existing };
    return { kind: "refused", bundle: existing, code: result.error.code };
  }

  const data = result.data;

  /*
    Unchanged: keep the descriptors we have but take the NEW expiry. This is what lets a gate
    that stays online keep renewing its permission to work offline later, without re-sending a
    few hundred kilobytes it already holds.
  */
  if (data.unchanged === true && existing !== null) {
    const renewed: FaceBundle = {
      ...existing,
      expiresAt: data.expiresAt ?? existing.expiresAt,
      fetchedAt: nowInstantIso(),
    };
    await saveBundle(renewed).catch(() => undefined);
    return { kind: "unchanged", bundle: renewed };
  }

  if (data.employees === undefined || data.version === undefined || data.expiresAt === undefined) {
    // A malformed answer must not replace a good bundle with a broken one.
    return { kind: "refused", bundle: existing, code: "BUNDLE_MALFORMED" };
  }

  const dim = data.descriptorDim ?? 128;
  const people: BundlePerson[] = [];
  for (const employee of data.employees) {
    const descriptors = employee.descriptors
      .filter((d) => Array.isArray(d) && d.length === dim)
      .map((d) => new Float32Array(d));
    // Somebody with no usable sample cannot be matched, so listing them would only make the
    // count lie about what the gate can actually do.
    if (descriptors.length > 0) {
      people.push({
        employeeId: employee.employeeId,
        employeeCode: employee.employeeCode,
        displayName: employee.displayName,
        employmentStatus: employee.employmentStatus,
        modelVersion: employee.modelVersion,
        descriptors,
      });
    }
  }

  const bundle: FaceBundle = {
    version: data.version,
    expiresAt: data.expiresAt,
    descriptorDim: dim,
    people,
    fetchedAt: nowInstantIso(),
  };
  await saveBundle(bundle).catch(() => undefined);
  return { kind: "updated", bundle };
}

/** Whether this browser can hold a bundle at all — private mode and some webviews cannot. */
export async function bundleStorageAvailable(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  try {
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}
