/**
 * A day claimed as on-duty may also say what hours were worked on it.
 *
 * ── WHAT WENT WRONG, IN ONE SENTENCE FROM THE PERSON IT HAPPENED TO ──────────
 * "I raised a regularisation ticket which was attended to by Sunil, but don't see any
 * changes in my login timings."
 *
 * She was right, and everything had worked. A sales manager took a client call from home at
 * 08:30, could not punch for it, and filed `on_duty`. It was approved and applied: the day is
 * `on_duty`, `status_source = regularized`, `day_fraction_paid = 1.000`. Paid in full.
 *
 * But `on_duty` and `work_from_home` are STATUS_KINDS, and the filing form rendered NO TIME
 * FIELDS for them at all — the section showed the kind's name and nothing else. So the request
 * carried `requested_first_in_at = NULL`, created no punches, and her day held:
 *
 *     on_duty, 0 worked minutes, first in 12:40   <- the gate scan from reaching the venue
 *
 * Paid correctly and recorded as having done nothing, with a login four hours after she
 * started. There was no way to say "on duty, from 08:30" because the screen did not ask.
 *
 * ── THE DATABASE ALWAYS ALLOWED IT ───────────────────────────────────────────
 * `requested_status` and the two time columns are independent, and
 * `apply_approved_regularization` creates the punches when times are present while setting the
 * status either way. Only the client forbade the combination.
 *
 * Verified against the live database on her own day, rolled back: `on_duty` carrying
 * 08:30–09:30 produced 2 punches and the day came back
 * "on_duty, 60 min, 08:30-12:40, paid 1.000" — the status kept, the hours now real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_KINDS, TIME_KINDS } from "./api/regularizations.api";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const form = strip(read("src", "features", "attendance", "pages", "NewRegularization.page.tsx"));

describe("the two families of kind stay distinct", () => {
  it("keeps a status kind a status kind", () => {
    // Offering hours must not turn `on_duty` into a time request.
    expect([...STATUS_KINDS]).toEqual(["on_duty", "work_from_home"]);
  });

  it("does not overlap with the time kinds", () => {
    for (const k of STATUS_KINDS) expect(TIME_KINDS).not.toContain(k);
  });
});

describe("times are offered on a status kind", () => {
  it("renders the fields for both families, not just the time kinds", () => {
    /*
      THE REGRESSION THIS EXISTS FOR. `{needsTimes ? <fields/> : <name/>}` is what left her
      with no way to state an hour.
    */
    expect(form).toContain("const allowsTimes = needsTimes || needsStatus;");
    expect(form).toContain("{allowsTimes ? (");
    expect(form).not.toContain("{needsTimes ? (");
  });

  it("computes the requested instants whenever they are offered", () => {
    // Gated on `needsTimes`, a typed hour on a status kind would be silently dropped.
    expect(form).toContain("allowsTimes && inTime.length === 5");
    expect(form).toContain("allowsTimes && outTime.length === 5");
  });

  it("still sends the status alongside them", () => {
    expect(form).toContain("const requestedStatus = needsStatus ? kind : null;");
  });
});

describe("but only REQUIRED where they are the request", () => {
  it("will not submit a time kind with no time", () => {
    expect(form).toContain(
      "? (requestedFirstInAt !== null || requestedLastOutAt !== null) && timesOrderOk",
    );
  });

  it("will submit a status kind with none", () => {
    /*
      Somebody claiming a whole day on duty with no particular hours must still be able to
      say exactly that — which is what the old form did correctly, and the only thing it did
      correctly here.
    */
    expect(form).toContain(": needsStatus && timesOrderOk;");
  });

  it("checks the ordering on both, so a typed pair cannot be backwards", () => {
    // The ordering rule is a CHECK constraint server-side (ck_ar__times_order); rejecting it
    // here is what stops a submit that would fail at the database.
    const complete = form.slice(form.indexOf("const timesComplete"));
    expect(complete.slice(0, 200)).toContain("timesOrderOk");
    expect(form).toContain("new Date(requestedLastOutAt).getTime() > new Date(requestedFirstInAt).getTime()");
  });

  it("tells the employee the hours are optional rather than leaving them guessing", () => {
    // `t()` has no missing-key fallback, so the key must exist for real.
    expect(form).toContain('t("reg.form.times.optional")');
    expect(read("src", "shared", "i18n", "en.ts")).toContain('"reg.form.times.optional"');
  });
});
