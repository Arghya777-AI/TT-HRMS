/**
 * FirstRun — E-01.3. Three steps, in order: set a password, confirm your
 * details, understand how clock-in works. Blocks every /me route until done
 * (see FirstRunGate).
 *
 * Every table write here goes through a feature `api/` module (architecture
 * D-01: a page never touches `@/lib/supabase`). `supabase.auth.updateUser` stays
 * — that is the auth client, not a table write, and there is no other way to set
 * a password.
 *
 * Two of the three writes are NOT simple updates, because the database does not
 * let an employee make them directly:
 *
 *   * `mobile` is not in the self-editable column grant on `employees`, so it is
 *     proposed as an `employee_change_requests` row for HR to approve
 *     (`submitSelfChangeRequest`). The wizard says so on screen — it does not
 *     claim the number is live.
 *   * the completion flags on `profiles` go through `markFirstRunComplete`, whose
 *     failure is surfaced rather than swallowed: if the stamp does not land the
 *     user is told, and is NOT navigated onward, because `FirstRunGate` would only
 *     send them straight back here.
 *
 * The reported loop was not either of those, though — see `initialStep`. The
 * wizard restarted at step 1 after the trip to /me/documents that step 4 requires,
 * and step 1 cannot be passed without setting a new password, so the last step was
 * unreachable and the gate never opened.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, Loader2, ScanFace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/app/auth/AuthProvider";
import { supabase } from "@/lib/supabase";
import { mutationUserMessage } from "@/shared/api/query";
import { clearMustChangePassword, markFirstRunComplete } from "@/features/profile/api/profile.api";
import { passwordIssues } from "@/shared/auth/password";
import { t } from "@/shared/i18n/en";
import { AuthLayout } from "./AuthLayout";
import { useQuery } from "@tanstack/react-query";
import { OnboardingChecklist } from "@/features/onboarding/components/OnboardingChecklist";
import { fetchMyOnboardingStatus } from "@/features/onboarding/api/onboarding.api";
import { fetchMyEmployeeProfile } from "@/features/profile/api/profile.api";
import { fetchContacts } from "@/features/profile/api/personal.api";

type Step = 1 | 2 | 3 | 4;

/**
 * Where to resume — and why this is not just `useState(1)`.
 *
 * REPORTED LOOP: "when i click to anywhere it redirect to set-password page, when
 * i reach to step then it redirect to [/me/documents] and it continue again and
 * again."
 *
 * Step 4 asks for documents, and uploading them happens on /me/documents — the one
 * other route `FirstRunGate` lets through, deliberately (see OnboardingChecklist:
 * re-implementing upload inside a wizard step would be a second path to the same
 * bucket). But leaving unmounts this page, so `step` reset to 1, and step 1 cannot
 * be passed without SETTING A NEW PASSWORD: `submitPassword` requires a valid,
 * confirmed password and calls `auth.updateUser`. So the joiner came back from
 * uploading, landed on "Set your password" again, and the only way back to step 4
 * was to invent another password. `finish()` — the sole writer of
 * `profile_confirmed_at` — was unreachable, the gate kept redirecting, forever.
 *
 * Two things fix it, both here:
 *   * remember the step across the trip to the documents screen (sessionStorage,
 *     not state: a full page load happens in between). Session-scoped, so it does
 *     not follow the user into a later sign-in.
 *   * never resume ONTO step 1 once the password is the user's own. If
 *     `must_change_password` is false there is nothing for that step to do, and
 *     demanding a new password to walk past it is what closed the trap.
 */
const STEP_KEY = "firstRun.step";

function isStep(n: number): n is Step {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

function initialStep(mustChangePassword: boolean): Step {
  /*
    WHEN THE PASSWORD IS STILL THE ISSUED ONE, STEP 1 IS NOT RESUMABLE PAST.

    The first version of this only RAISED the stored step to a floor, never capped
    it. With `must_change_password` true the floor was 1, so a stored 2, 3 or 4 was
    honoured verbatim — and step 1 is the only screen that calls
    `auth.updateUser({ password })`. A joiner who had reached step 4 in this tab,
    or anyone handed a temporary password in a tab where an earlier wizard had
    stored a later step, resumed past the password change and never made one.
    `sessionStorage` is not cleared on sign-out either, so the stale key outlives
    the session that wrote it.

    So while the flag is set, the answer is always 1 regardless of what is stored:
    a forced change that can be resumed past is not a forced change.
  */
  if (mustChangePassword) return 1;

  const raw = Number.parseInt(sessionStorage.getItem(STEP_KEY) ?? "", 10);
  return isStep(raw) && raw >= 2 ? raw : 2;
}

export default function FirstRun() {
  const navigate = useNavigate();
  const { employee, user, refresh } = useAuth();
  const [step, setStepState] = useState<Step>(() =>
    initialStep(employee?.mustChangePassword === true),
  );

  const setStep = (next: Step) => {
    sessionStorage.setItem(STEP_KEY, String(next));
    setStepState(next);
  };

  /*
    ── THE DOCUMENT PACK IS SKIPPED WHEN THERE IS NOTHING LEFT TO ASK ──────────────

    The wizard used to render step 4 unconditionally, so somebody whose onboarding HR had
    already WAIVED was still shown "Required — 0 of 5 done" and asked for an Aadhaar card
    every time they signed in. The waiver said the paperwork did not apply and the screen
    asked for it anyway — and the screen is what the reader believes.

    `null` while it loads, so the wizard never flashes a step it is about to skip.
    Defaults to SHOWING the pack if the read fails: a joiner who genuinely owes documents
    being asked once too often is a far better failure than one who owes them never being
    asked at all.
  */
  const packSettled = useQuery({
    queryKey: ["onboarding", "status"],
    queryFn: ({ signal }) => fetchMyOnboardingStatus(signal),
    retry: false,
  });
  const skipPack = packSettled.data !== undefined &&
    (packSettled.data.waived || packSettled.data.submitted);

  /*
    ── STEP 2 IS SKIPPED WHEN THE RECORD ALREADY ANSWERS IT ────────────────────────

    REPORTED: "once I login and fill other details then during change password time
    why it is asking to fill these details again".

    Step 2 asks for a mobile number and an emergency contact and wrote them
    unconditionally, with no reference to whether the employee record already had
    them. So anyone who had already given HR those details — or who had been
    through this wizard once before without reaching the end — was asked for them
    again, and a second emergency contact was inserted on top of the first.

    Asking a person for something the system already knows is how a form teaches
    people that it is not paying attention. So it is skipped when both facts are on
    file, exactly as the document pack is skipped when there is nothing left to owe.

    Defaults to SHOWING the step while the reads are in flight or if they fail: being
    asked once too often is a far better failure than a joiner with no emergency
    contact on record.
  */
  const detailsOnFile = useQuery({
    queryKey: ["firstRun", "detailsOnFile", employee?.employeeId ?? "none"],
    // employeeId is `string | null`, so a truthiness check, not `!== undefined`.
    enabled: Boolean(employee?.employeeId),
    retry: false,
    queryFn: async ({ signal }) => {
      const id = employee?.employeeId;
      if (id === null || id === undefined) return false;
      const [me, contacts] = await Promise.all([
        fetchMyEmployeeProfile(signal),
        fetchContacts(id, signal),
      ]);
      const hasMobile = (me?.mobile ?? "").trim() !== "";
      const hasEmergency = contacts.some((c) => c.contact_kind === "emergency");
      return hasMobile && hasEmergency;
    },
  });
  const skipDetails = detailsOnFile.data === true;

  /*
    A step can become skippable AFTER it is already the current one — the reads
    above resolve a moment later, and sessionStorage can restore a 2 from an
    earlier visit. Without this the page would render its header and progress dots
    over an empty body, which is the dead end the document step used to have.
  */
  useEffect(() => {
    if (step === 2 && skipDetails) setStep(3);
  }, [step, skipDetails]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mobile, setMobile] = useState("");
  const [emergencyName, setEmergencyName] = useState("");
  const [emergencyRelation, setEmergencyRelation] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const pwIssues = password.length > 0 ? passwordIssues(password, {
    employeeCode: employee?.employeeCode ?? null,
    firstName: employee?.displayName?.split(" ")[0] ?? null,
  }) : [];
  const pwOk = password.length > 0 && pwIssues.length === 0 && confirm === password;

  const MOBILE_RE = /^[6-9]\d{9}$/;
  /*
    Split into the two independent facts this step collects, because they are now
    saved independently — see `saveDetailsAndContinue`. `detailsOk` (both present)
    is still what enables the primary button.
  */
  const mobileOk = MOBILE_RE.test(mobile);
  const emergencyOk =
    emergencyName.trim().length > 1 &&
    emergencyRelation.trim().length > 1 &&
    MOBILE_RE.test(emergencyPhone) &&
    emergencyPhone !== mobile; // an emergency contact cannot be your own number
  const detailsOk = mobileOk && emergencyOk;

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!pwOk) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        toast.error(error.message);
        return;
      }
      /*
        CLEAR THE FLAG HERE, WHERE THE PASSWORD ACTUALLY CHANGED.

        It used to be cleared only by `finish()`, three steps later, with no
        reference to whether this call had ever run — so the one fact
        `must_change_password` asserts ("the password is still the one we issued")
        was being retracted by completing an unrelated form, and left standing by
        somebody who changed their password and then closed the tab. Both
        directions were wrong.

        Failure is deliberately NOT fatal: the password IS changed at this point,
        and blocking the wizard would strand someone whose credential is already
        the new one. `finish()` writes it again, so a transient failure self-heals;
        until then the only cost is being asked once more.
      */
      if (user?.id) {
        try {
          await clearMustChangePassword(user.id);
          await refresh();
        } catch {
          // Not fatal: finish() writes the same flag, so this self-heals.
        }
      }
      // Straight to 3 when the record already holds the mobile and the emergency
      // contact: step 2 would have nothing left to ask.
      setStep(skipDetails ? 3 : 2);
    } finally {
      setBusy(false);
    }
  }

  /*
    ── EVERY STEP EXCEPT THE PASSWORD CAN BE SKIPPED ───────────────────────────────

    ASKED FOR: "u can keep option to skip other than password creation part like
    friends details and upload document". The password is the one thing that must
    happen — until it does, the credential is still the one HR issued and typed into
    an email — so step 1 stays compulsory. Everything after it is HR's paperwork, and
    holding a person out of the app until they have their emergency contact's phone
    number to hand only teaches them to type something false.

    SKIPPING SAVES WHAT IS ALREADY VALID rather than discarding it, which is why the
    two facts are written separately. A mobile number stands on its own; an emergency
    contact needs all three of its fields to be a contact at all. Someone who fills
    in their mobile, cannot remember a relative's number and skips should not find
    their mobile thrown away for the sake of the half they could not complete.

    Both buttons come here. The primary one is enabled only when both facts are
    complete; the skip runs the same save with whatever is there. Neither can fail
    into a dead end: `setStep(3)` is in `finally`.
  */
  async function saveDetailsAndContinue() {
    const id = employee?.employeeId;
    // Nothing to write against, or nothing worth writing — but never a dead end.
    if (id === null || id === undefined || (!mobileOk && !emergencyOk)) {
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      if (mobileOk) {
        await supabase.from("employees").update({ mobile }).eq("id", id);
      }
      if (emergencyOk) {
        await supabase.from("employee_contacts").insert({
          employee_id: id,
          contact_kind: "emergency",
          value: emergencyPhone,
          contact_name: emergencyName.trim(),
          relationship: emergencyRelation.trim(),
          is_primary: true,
        });
      }
    } catch {
      toast.info("Saved what we could — HR will confirm the rest.");
    } finally {
      setBusy(false);
      setStep(3);
    }
  }

  async function submitDetails(e: FormEvent) {
    e.preventDefault();
    await saveDetailsAndContinue();
  }

  /*
    Through the api module (D-01), and the error is NOT discarded. This write used
    to be an inline `supabase.from("profiles").update(...)` whose `{ error }` was
    thrown away, so a refusal looked exactly like success: the page navigated to
    /me, `FirstRunGate` saw the flags unchanged and sent the user back here.

    Do not navigate unless the stamp actually landed. Being told plainly that it
    failed beats a silent bounce between two screens.
  */
  async function finish() {
    setBusy(true);
    try {
      if (!user?.id) throw new Error("No signed-in profile to stamp");
      await markFirstRunComplete(user.id);
      sessionStorage.removeItem(STEP_KEY);
      await refresh();
      navigate("/me", { replace: true });
    } catch (e) {
      toast.error(mutationUserMessage(e), {
        description:
          "We could not record that you finished setting up, so you will see this screen again. Tell HR if it keeps happening.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t("auth.firstRun.title")}
      description={
        step === 1
          ? t("auth.firstRun.step1")
          : step === 2
            ? t("auth.firstRun.step2")
            : step === 3
              ? t("auth.firstRun.step3")
              : t("onboarding.step")
      }
    >
      <ol className="mb-5 flex items-center gap-2 text-xs text-muted-foreground" aria-label="Progress">
        {/* FOUR dots, not three. A fourth step was added (the HR-configured paperwork) and
            leaving this at three made the indicator lie: somebody on the last step saw a
            filled "3 of 3" and then another screen. */}
        {(skipPack ? ([1, 2, 3] as const) : ([1, 2, 3, 4] as const)).map((n) => (
          <li key={n} className="flex flex-1 items-center gap-2">
            <span
              className={
                n <= step
                  ? "grid h-6 w-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground"
                  : "grid h-6 w-6 place-items-center rounded-full bg-muted text-xs"
              }
            >
              {n}
            </span>
            {n < 3 ? <Separator className="flex-1" /> : null}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <form onSubmit={submitPassword} className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("auth.password.policy")}</p>
          <div className="space-y-2">
            <Label htmlFor="pw">{t("auth.reset.newPassword")}</Label>
            <Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {pwIssues.length > 0 ? (
              <ul className="space-y-0.5 text-xs text-destructive">
                {pwIssues.map((i) => <li key={i}>{i}</li>)}
              </ul>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="pw2">{t("auth.reset.confirmPassword")}</Label>
            <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full" disabled={!pwOk || busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("auth.firstRun.next")}
          </Button>
        </form>
      ) : null}

      {step === 2 && !skipDetails ? (
        <form onSubmit={submitDetails} className="space-y-4">
          {employee ? (
            <dl className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{employee.displayName ?? "—"}</dd>
              </div>
              <div className="mt-1 flex justify-between gap-2">
                <dt className="text-muted-foreground">Employee code</dt>
                <dd className="font-mono">{employee.employeeCode ?? "—"}</dd>
              </div>
            </dl>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="mobile">Your mobile number</Label>
            <Input id="mobile" inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ""))} required />
          </div>

          <fieldset className="space-y-2 rounded-md border p-3">
            {/* Not "(required)" any more — a label that says required beside a button
                that says skip teaches the reader to disbelieve the labels. HR still
                needs it, and their console still shows it outstanding. */}
            <legend className="px-1 text-xs font-medium text-muted-foreground">Emergency contact</legend>
            <Input placeholder="Full name" value={emergencyName} onChange={(e) => setEmergencyName(e.target.value)} required />
            <Input placeholder="Relationship" value={emergencyRelation} onChange={(e) => setEmergencyRelation(e.target.value)} required />
            <Input placeholder="Phone" inputMode="numeric" maxLength={10} value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value.replace(/\D/g, ""))} required />
          </fieldset>

          {/*
            SKIP, WHERE "BACK" USED TO BE. Back went to step 1 — and step 1 cannot be
            walked past without calling `auth.updateUser({ password })`, because that
            is the only thing its button does. By the time this step is on screen the
            password has already been changed, so Back led to a screen demanding a
            SECOND new password before it would let go, escapable only by reloading
            the tab. That is the same trap the sessionStorage resume was written to
            close, one step along. There is nothing on step 1 to go back FOR: a
            password is changed from Settings afterwards, not from here.
          */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={() => void saveDetailsAndContinue()}
            >
              Skip for now
            </Button>
            <Button type="submit" className="flex-1" disabled={!detailsOk || busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("auth.firstRun.next")}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
            <ScanFace className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="text-sm">
              <p className="font-medium">Clock in at the gate camera</p>
              <p className="mt-1 text-muted-foreground">
                Look at the camera when you arrive and again when you leave. Your first scan of the day is your
                check-in and your last is your check-out — extra scans in between are harmless.
              </p>
            </div>
          </div>
          <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="text-sm">
              <p className="font-medium">Nothing to install</p>
              <p className="mt-1 text-muted-foreground">
                The guard operates the camera. If it can&apos;t recognise you, they will confirm your identity and
                you can raise a correction here afterwards.
              </p>
            </div>
          </div>
          {/*
            Onwards to the paperwork rather than straight out, so the pack is at least
            SHOWN once. It is not that finishing here would bounce them back — the gate
            holds on `must_change_password` and `profile_confirmed_at` only (guards.tsx),
            both of which `finish()` writes, and `skipPack` above proves it by calling
            `finish()` directly. Leaving without the documents is a choice the joiner
            makes on the next screen, not one this button makes silently for them.
          */}
          <Button
            className="w-full"
            onClick={() => (skipPack ? void finish() : setStep(4))}
            disabled={busy || packSettled.isPending}
          >
            {t("auth.firstRun.finish")}
          </Button>
        </div>
      ) : null}

      {/*
        STEP 4 — the HR-configured pack. It is last because everything before it is fixed
        (a password, a phone, how the gate works) while this step's contents are whatever HR
        configured for this employment type, and may be nothing at all.
      */}
      {step === 4 && !skipPack ? (
        <div className="space-y-4">
          <OnboardingChecklist onSubmitted={() => void finish()} />
          {/*
            SKIPPING THE PACK IS NOT THE SAME AS SUBMITTING IT, AND MUST NOT LOOK LIKE IT.

            The checklist's own button calls `submit_onboarding()`, which refuses while a
            required item is missing — correctly, because that RPC is the joiner ASSERTING
            the paperwork is complete. This one deliberately does not call it. It stamps
            `profile_confirmed_at` and nothing else, so `employee_onboarding.submitted_at`
            stays null and HR's console (`v_onboarding_admin`, which counts
            `is_required_for_onboarding` and never looks at the employee-facing flags) goes
            on showing this person as outstanding until the documents actually arrive.

            Which is the honest outcome: the obligation survives, the joiner is not locked
            out of the app over a photograph, and nobody is recorded as having declared
            something they did not.
          */}
          <Button
            variant="ghost"
            className="w-full"
            disabled={busy}
            onClick={() => void finish()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Skip for now — upload these later from My documents
          </Button>
        </div>
      ) : null}
    </AuthLayout>
  );
}
