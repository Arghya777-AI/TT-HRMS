/**
 * Register a face and the person works — the steps that used to sit in between.
 *
 * ── THE SHAPE OF THE BUG THIS AREA KEEPS PRODUCING ───────────────────────────
 * Every failure here has been SILENT. `face-enrol` wrote every template `is_active = false`, so
 * a capture that reported success matched nothing: not the gate, not face sign-in (which needs
 * an active template whatever `allow_face_login` says), and web punch stayed off because
 * `allow_web_punch` defaults FALSE. Nothing on any screen said a second step was owed.
 *
 * The console later papered over it with a SECOND request — `face-template-admin op=approve` —
 * fired from an effect whose catch block swallowed the error. That reintroduced the same class
 * of defect one level up: capture committed, activation failed, admin told it worked.
 *
 * `face-enrol` now approves an admin-performed enrolment inside its own transaction, so it
 * cannot half-happen. These assertions exist because none of that is visible in a build, a
 * typecheck, or a screenshot of a green success notice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const enrol = read("supabase", "functions", "face-enrol", "index.ts");
const capture = read("src", "features", "admin", "components", "EnrolCapture.tsx");

describe("an admin-performed enrolment goes live in one transaction", () => {
  it("activates the medoid, so the face actually matches", () => {
    // Templates are inserted `is_active = false`; without this the enrolment matches nothing.
    expect(enrol).toContain("is_active   = (id = ${representative.id}::uuid)");
  });

  it("retires the previous active row BEFORE activating the new one", () => {
    /*
      `uq_face_templates__employee_active` permits exactly one active row per employee, so the
      wrong order raises a unique violation — on a RE-enrolment only, which is the case a first
      enrolment would never surface.
    */
    const retire = enrol.indexOf("deactivation_reason = ${`superseded by v${version}");
    const activate = enrol.indexOf("is_active   = (id = ${representative.id}::uuid)");
    expect(retire).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(activate);
  });

  it("stamps face_enrolled_at and closes the queue row", () => {
    expect(enrol).toContain("SET face_enrolled_at = now()");
    expect(enrol).toContain("SET status                = 'approved'::public.approval_status");
  });

  it("grants web punch, which defaults false and is the switch nobody finds", () => {
    expect(enrol).toContain("SET allow_web_punch = true");
    // GRANT only: a deliberate revocation must survive a re-enrolment.
    expect(enrol).toContain("AND allow_web_punch = false");
  });

  it("does all of it inside the enrolment's own transaction", () => {
    /*
      The writes must sit inside the `withContext(ctx, async (tx) => ...)` block that inserts
      the templates — not after it. Outside, a failure leaves a captured-but-dead template,
      which is the original bug wearing a different hat.
    */
    const txStart = enrol.indexOf("INSERT INTO secure.face_templates");
    const txEnd = enrol.indexOf("// ── Response ─");
    const activate = enrol.indexOf("is_active   = (id = ${representative.id}::uuid)");
    expect(txStart).toBeGreaterThan(-1);
    expect(txEnd).toBeGreaterThan(txStart);
    expect(activate).toBeGreaterThan(txStart);
    expect(activate).toBeLessThan(txEnd);
  });
});

describe("the cases that still need a human keep needing one", () => {
  it("declines to auto-approve a near-duplicate or a low-cohesion capture", () => {
    /*
      A near-duplicate means this face sits close to somebody else's enrolment — approving it
      lets two people match as one at the gate, and it is not something the capturing admin can
      see by looking at the person. Low cohesion means the samples disagree, so the template
      would match unreliably.
    */
    expect(enrol).toContain('duplicateOutcome !== "warn"');
    expect(enrol).toContain("!lowCohesion");
  });

  it("never auto-approves a kiosk capture", () => {
    // A guard is not an admin; nobody with authority necessarily saw who stood at the camera.
    expect(enrol).toContain('actor.channel === "web"');
  });

  it("can be switched off entirely without a deploy", () => {
    expect(enrol).toContain("biometric.auto_approve_admin_enrolment");
  });
});

describe("what the admin is told matches what happened", () => {
  it("reports approval as needed only when it really is", () => {
    // Was `true as const` — it sent admins to a queue with nothing in it for them.
    expect(enrol).toContain("requiresApproval: !result.autoApproved");
    expect(enrol).not.toContain("requiresApproval: true as const");
  });

  it("does not claim a live template is pending", () => {
    expect(enrol).toContain('result.autoApproved ? ("active" as const) : ("pending_approval" as const)');
  });

  it("stops firing a second activation request from the client", () => {
    /*
      The old effect called `approve` after a successful enrol and swallowed the failure. It
      would now hit FACE_TEMPLATE_ALREADY_APPROVED and surface a conflict on the success path.
    */
    expect(capture).not.toContain("useTemplateApproveMutation");
    expect(capture).not.toContain("approve.saveAsync");
  });

  it("says which of the two outcomes happened", () => {
    expect(capture).toContain("admin.enrolCap.doneLive");
    expect(capture).toContain("admin.enrolCap.doneNeedsReview");
    // The stale instruction to go and activate it is gone.
    expect(read("src", "shared", "i18n", "en.ts")).not.toContain('"admin.enrolCap.done":');
  });
});
