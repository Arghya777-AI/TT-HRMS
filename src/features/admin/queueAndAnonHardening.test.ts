/**
 * Two pieces of housekeeping that were quietly costing something.
 *
 * ── 1. THE RECOMPUTE QUEUE NEVER GAVE UP ─────────────────────────────────────
 * Fourteen rows for one employee sat unprocessed with 43,338 attempts each and the same error
 * every time: `employee_not_found`. That employee is soft-deleted and
 * `compute_attendance_day` selects `WHERE deleted_at IS NULL`, so it raised and always would.
 * The drain's handler cleared `claimed_at` and bumped `attempts`, and the claim predicate had
 * no ceiling — so pg_cron picked the same fourteen up again the next minute, for about a month.
 *
 * The part that is worse than wasted work: `uq_arq__pending` is UNIQUE on
 * (employee_id, ist_date) WHERE processed_at IS NULL and `enqueue_recompute` inserts
 * ON CONFLICT DO NOTHING, so a permanently-pending row SWALLOWS every future enqueue for that
 * same day. Had that employee been restored, those days could never have been recomputed —
 * silently, with nothing on any screen to explain it.
 *
 * ── 2. `anon` COULD REACH THIRTEEN VIEWS ─────────────────────────────────────
 * And the correction matters: it got NO DATA from any of them. Ten are refused because each
 * view's WHERE clause calls an `app.*` helper `anon` cannot execute; three returned nothing
 * because their tables are empty. So nothing was exposed — but the protection was one grant on
 * a helper function, and three of the views have no scoping of their own at all. The first exit
 * recorded would have published who is leaving to anybody holding the publishable key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

const queue = strip(read("20260904100000_the_queue_gives_up_on_the_impossible.sql"));
const anon = strip(read("20260904090000_anon_reads_no_view_at_all.sql"));

describe("the queue gives up on a day it can never compute", () => {
  it("caps how many times a row is claimed", () => {
    expect(queue).toContain("MAX_ATTEMPTS constant integer := 20");
    expect(queue).toContain("AND attempts < MAX_ATTEMPTS");
  });

  it("stamps processed_at on the row it abandons, freeing the dedup slot", () => {
    /*
      THE SUBTLE HALF. Leaving it pending would keep `uq_arq__pending` occupied and make every
      later `enqueue_recompute` for that employee and date a silent no-op.
    */
    expect(queue).toContain(
      "processed_at = CASE WHEN attempts + 1 >= MAX_ATTEMPTS THEN now() ELSE NULL END",
    );
  });

  it("keeps the error and the count on the abandoned row", () => {
    // "Processed" means the queue is finished with it, not that it succeeded — so the reason it
    // stopped has to stay legible on the row.
    expect(queue).toContain("attempts   = attempts + 1");
    expect(queue).toContain("last_error = SQLERRM");
  });

  it("retires the rows that were already past any sane ceiling, without deleting them", () => {
    expect(queue).toContain("SET processed_at = now()");
    expect(queue).toContain("AND attempts >= 20");
    expect(queue).not.toMatch(/DELETE\s+FROM\s+public\.attendance_recompute_queue/i);
  });

  it("still recomputes through the same engine call", () => {
    // The fix is about when to stop trying, not about what a successful drain does.
    expect(queue).toContain("public.compute_attendance_day(r.employee_id, r.ist_date, r.reason)");
  });
});

describe("anon reads no view", () => {
  it("revokes every view it could reach, found dynamically", () => {
    /*
      A dynamic sweep rather than a hand-written list: the grants come from Supabase's default
      privileges, so the set is whatever those produced — naming thirteen views would go stale
      the next time somebody adds one.
    */
    expect(anon).toContain("has_table_privilege('anon', c.oid, 'SELECT')");
    expect(anon).toContain("REVOKE ALL ON TABLE public.%I FROM anon");
  });

  it("stops the next view arriving open", () => {
    expect(anon).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM anon");
  });

  it("leaves authenticated alone", () => {
    /*
      The application reads all of these WITH a session, and each is scoped by its own gate
      function or by RLS underneath. Revoking `authenticated` would break thirteen live screens
      to fix an exposure of zero rows.
    */
    expect(anon).not.toMatch(/REVOKE[^;]*FROM\s+authenticated/i);
  });

  it("does not reach for security_invoker, which would change what every caller sees", () => {
    // The right long-term shape, but a behavioural change to thirteen working screens.
    expect(anon).not.toContain("security_invoker");
  });
});
