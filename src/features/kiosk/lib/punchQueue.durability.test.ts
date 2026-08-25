/**
 * The queue's durability guarantees, and the audit trail that proves them.
 *
 * The queue is the only place an offline morning's attendance exists, so the properties worth
 * asserting are the ones whose failure loses a record: that the sync history is written before
 * the queue entry is dropped, that a bounded history cannot grow without limit, and that
 * persistent storage is requested rather than assumed.
 *
 * jsdom has no IndexedDB, so these are source-level assertions on the ordering and the bounds.
 * The alternative — no check at all on the ordering that protects the evidence — is worse.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const queue = readFileSync(join(ROOT, "src/features/kiosk/lib/punchQueue.ts"), "utf8");
const sync = readFileSync(join(ROOT, "src/features/kiosk/lib/punchSync.ts"), "utf8");

describe("nothing is lost when the app is closed", () => {
  it("asks the browser for storage it will not evict", () => {
    /*
      IndexedDB already survives closing, reloading and a power cycle. What it does not survive
      by default is EVICTION — under disk pressure, and on Safari after seven days without a
      visit for anything not installed. A gate that queued a morning and was closed over a long
      weekend could lose it silently, which is the one failure the queue exists to prevent.
    */
    expect(queue).toContain("navigator.storage.persist");
    expect(queue).toContain("navigator.storage.persisted");
    // Reports what was actually granted, so the screen can say rather than assume.
    expect(queue).toMatch(/"persisted" \| "best-effort" \| "unsupported"/);
  });

  it("upgrades the database additively, so an outage survives the migration", () => {
    // A device mid-outage runs this upgrade holding the only copy of that morning's punches.
    expect(queue).toContain("const DB_VERSION = 2;");
    expect(queue).toMatch(/if \(!db\.objectStoreNames\.contains\(SYNC_LOG\)\)/);
    expect(queue).toMatch(/if \(!db\.objectStoreNames\.contains\(STORE\)\)/);
  });
});

describe("the sync audit trail", () => {
  it("is written BEFORE the queue entry is dropped", () => {
    /*
      Order is the whole guarantee. Acknowledging first and failing before the log wrote would
      lose the only trace the punch was ever on this device. This way the worst case is a record
      that says "sent" for something still queued — which the next flush resolves harmlessly,
      because the server dedups on the event id.
    */
    const body = sync.slice(sync.indexOf("if (done.length > 0)"));
    const logged = body.indexOf("recordSynced");
    const dropped = body.indexOf("acknowledge(done)");
    expect(logged).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(-1);
    expect(logged).toBeLessThan(dropped);
  });

  it("records when each scan actually reached the server", () => {
    expect(queue).toContain("syncedAt: string;");
    expect(queue).toContain("capturedAt: string;");
    // Both instants, because during an outage the GAP is the interesting number.
    expect(sync).toContain("capturedAt: item.capturedAt,");
  });

  it("is bounded, so a terminal left running for a year does not fill its own storage", () => {
    expect(queue).toContain("const SYNC_LOG_LIMIT = 500;");
    // Oldest dropped first — the recent history is the useful one.
    expect(queue).toContain("a.syncedAt.localeCompare(b.syncedAt)");
  });

  it("never lets the history cost a punch", () => {
    // Every path around the log swallows its own failures: it is a convenience, the queue is
    // the record.
    const fn = queue.slice(queue.indexOf("export async function recordSynced"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("catch");
  });
});

describe("the replay is fast enough to be useful", () => {
  it("sends the largest batch the server accepts", () => {
    // 5 meant 40 round trips for 200 held punches, each with its own HMAC, TLS and 1:N latency.
    expect(sync).toContain("const BATCH_SIZE = 25;");
  });

  it("does not mistake a throttled queue for a disconnected gate", () => {
    /*
      429 is neither offline nor a bad scan. Setting the lamp to offline there would tell the
      person at the door a false story about the network.
    */
    expect(sync).toContain("rateLimited = result.error.status === 429;");
    const flag = sync.slice(sync.indexOf("offline = result.error.status === 0"));
    expect(flag.slice(0, 200)).not.toMatch(/offline = .*429/);
  });
});
