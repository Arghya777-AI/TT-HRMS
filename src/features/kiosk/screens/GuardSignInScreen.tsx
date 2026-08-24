/**
 * GuardSignInScreen — "Who is at the duty of the security gate? Kindly log in."
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DECISION, AND WHAT IT COSTS
 * ═════════════════════════════════════════════════════════════════════════════
 * Option (b): THE FACE IDENTIFIES THE GUARD, THE PIN AUTHORISES THE SHIFT. The
 * front camera names whoever is standing there — from the operator roster only —
 * and the keypad then opens the session with that name pre-filled. The guard types
 * a PIN once per shift instead of a name and a PIN.
 *
 * Why not option (a), face + device HMAC and no PIN:
 *   * A face is an identifier, not a secret — it is on the guard's own WhatsApp
 *     profile picture. `face-login/index.ts` already wrote this repo's position
 *     down and refuses to let a 1:N face match hand over session authority, and an
 *     open operator session IS authority: it is what `kiosk-punch` accepts for
 *     everyone who walks through the gate for the rest of the shift.
 *   * The device HMAC is POSSESSION OF THE TABLET, not knowledge of a secret. It
 *     lives in this browser's localStorage on a phone that sits at a gate all day
 *     (its own file says so, and the defence is admin revocation). So "face +
 *     device" collapses to "hold the gate phone and hold up a photo of the guard",
 *     which is one photograph away from a stranger opening a shift.
 *   * There is no liveness check in this build. `admin.kiosk.policy` can turn
 *     liveness OFF entirely, and its own copy admits a printed photo would then
 *     pass. Until liveness is real, a printed photo must not be able to start a
 *     shift.
 *   * The PIN is typed ONCE PER SHIFT. It costs about five seconds a day; the
 *     face still removes the part the client actually complained about, which is
 *     keying an employee code on a phone at a gate.
 *
 * What the trade-off costs, stated plainly: the guard still has to remember a
 * PIN, and if they forget it the gate needs a supervisor — exactly as today. What
 * it buys: a photograph of a guard cannot open a session, and the audit trail
 * keeps saying "this human proved a secret", which is what makes every punch that
 * follows defensible.
 *
 * Either way the same hard rule holds, and it is enforced server-side twice: the
 * signer-in must be an employee with an ACTIVE `public.kiosk_operators` row for
 * this device. `kiosk-guard-identify` will not even name a face that is not on
 * that roster, and `kiosk-operator-auth` re-checks the row before it mints a
 * token. A face match is identification; the roster row plus the PIN is
 * authorisation.
 *
 * DEGRADATION, which is not optional: if `kiosk-guard-identify` is not deployed
 * on this project the screen says so in one sentence and falls back to typing the
 * employee code. The PIN path is byte-for-byte the one that works today.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import {
  identifyGuardByFace,
  isDevicePairingDead,
  openOperatorSession,
  openSessionByFace,
  type GuardIdentity,
  type KioskDeviceState,
} from "../lib/deviceAuth";
import { runGateLoop, type GateSignal } from "../lib/gateScanner";
import { guidanceLine } from "../lib/gateCopy";
import { CameraProblem, GateFrame } from "../components/GateChrome";
import { CameraChoice } from "../components/CameraChoice";
import { GateBanner } from "../components/GateResult";
import { Keypad, PinDots } from "../components/Keypad";
import { Viewfinder } from "../components/Viewfinder";
import { useCamera } from "../hooks/useCamera";
import type { EngineStatus } from "../lib/engine";

/** Between face attempts, so a guard who is not enrolled cannot spin the endpoint
 * (and cannot burn the device's rate-limit bucket) by standing in front of it. */
const RETRY_GAP_MS = 2_500;

type FaceState =
  | { kind: "scanning" }
  | { kind: "checking" }
  | { kind: "not_recognised" }
  | { kind: "unavailable" }
  | { kind: "error"; detail: string };

export function GuardSignInScreen({
  device,
  engine,
  onOpen,
  onUnpaired,
}: {
  device: KioskDeviceState;
  engine: EngineStatus;
  onOpen: (state: KioskDeviceState) => void;
  /**
   * The device's pairing is dead (secret rotated by a re-issued code, or the device
   * revoked). Nothing this screen can do will work; the page drops the stored state
   * and shows the pairing screen.
   */
  onUnpaired: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Always the FRONT camera here, whatever the queue was last scanned with:
  // "The security guy scans his face first with the front camera."
  const camera = useCamera(videoRef, { initial: "user", remember: false });

  const [typing, setTyping] = useState(false);
  const [identity, setIdentity] = useState<GuardIdentity | null>(null);
  const [faceState, setFaceState] = useState<FaceState>({ kind: "scanning" });
  const [signal, setSignal] = useState<GateSignal>({ kind: "idle" });

  const [typedCode, setTypedCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextAttemptAt = useRef(0);

  /**
   * `onOpen` by ref, for the same reason `GateScanScreen` holds its device and its
   * expiry callback that way: the face loop now calls it, and taking it as an effect
   * dependency would tear the detector down and restart it every time the parent
   * re-created the callback — mid-scan, with a request possibly in flight.
   */
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  /** Same reasoning as `onOpenRef`: the face loop calls it and must not restart. */
  const onUnpairedRef = useRef(onUnpaired);
  useEffect(() => {
    onUnpairedRef.current = onUnpaired;
  }, [onUnpaired]);

  const scanning = !typing &&
    identity === null &&
    engine.kind === "ready" &&
    camera.state.status === "live";

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    // A camera switch restarts this loop; a "checking" left over from the loop
    // that was torn down would otherwise sit on screen until the next attempt.
    setFaceState((prev) => (prev.kind === "checking" ? { kind: "scanning" } : prev));
    void runGateLoop({
      // Async to match the loop's frame accessor. Always the live element here.
      video: () => Promise.resolve(videoRef.current),
      paused: () => performance.now() < nextAttemptAt.current,
      cancelled: () => cancelled,
      onSignal: (next) => {
        if (!cancelled) setSignal(next);
      },
      onReading: async (reading) => {
        if (cancelled) return;
        setFaceState({ kind: "checking" });

        /*
          AN ADMIN'S FACE OPENS THE SHIFT OUTRIGHT — no PIN.

          Tried FIRST, because for an admin it is the whole interaction: they hold the
          phone up and the gate is open. For everybody else it costs one request and
          falls through to exactly the behaviour that was here before, which is why
          `not_admin` is not an error and shows no message — a guard seeing "you are
          not an administrator" every time they approached the gate would be worse
          than the typing it saves.

          `not_available` matters for a project where this function is not deployed:
          the screen must degrade to the PIN rather than sit on a dead camera.
        */
        const face = await openSessionByFace(device, reading.descriptor);
        if (cancelled) return;
        if (face.kind === "opened") {
          onOpenRef.current(face.state);
          return;
        }
        if (face.kind === "unpaired") {
          // The device secret is dead — every request from this browser, face or PIN,
          // will fail the same way. Go back to pairing, which is the only recovery.
          onUnpairedRef.current();
          return;
        }
        if (face.kind === "error") {
          setFaceState({ kind: "error", detail: face.detail });
          nextAttemptAt.current = performance.now() + RETRY_GAP_MS;
          return;
        }

        // Not an admin, not recognised, or not deployed: name the person so they only
        // have to type a PIN, which is what this screen already did.
        const outcome = await identifyGuardByFace(device, reading.descriptor);
        if (cancelled) return;
        switch (outcome.kind) {
          case "identified":
            setIdentity(outcome.identity);
            return;
          case "not_recognised":
            setFaceState({ kind: "not_recognised" });
            nextAttemptAt.current = performance.now() + RETRY_GAP_MS;
            return;
          case "not_available":
            // The op is not on this project. Say it once and get out of the way.
            setFaceState({ kind: "unavailable" });
            setTyping(true);
            return;
          case "error":
            setFaceState({ kind: "error", detail: outcome.detail });
            nextAttemptAt.current = performance.now() + RETRY_GAP_MS;
            return;
        }
      },
    }).catch(() => {
      if (!cancelled) setFaceState({ kind: "error", detail: t("kiosk.gate.engine.failedHint") });
    });
    return () => {
      cancelled = true;
    };
  }, [scanning, device]);

  const employeeCode = identity?.employeeCode ?? typedCode.trim().toUpperCase();

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await openOperatorSession(device, employeeCode, pin);
    setBusy(false);
    if (result.ok) {
      onOpen(result.data);
      return;
    }
    // The PIN path hits the same dead signature the face path does — this is the
    // branch that made "Type my code instead" a second dead end rather than an
    // escape route.
    if (isDevicePairingDead(result.error.code)) {
      onUnpaired();
      return;
    }
    setPin("");
    setError(result.error.detail);
  }, [device, employeeCode, pin, onOpen, onUnpaired]);

  const startOver = () => {
    setIdentity(null);
    setTypedCode("");
    setPin("");
    setError(null);
    setFaceState({ kind: "scanning" });
    setTyping(false);
    nextAttemptAt.current = 0;
  };

  const faceBanner = (() => {
    if (engine.kind === "loading") {
      return { tone: "busy" as const, big: t("kiosk.gate.engine.loading"), small: t("kiosk.gate.engine.loadingHint") };
    }
    if (engine.kind === "failed") {
      return { tone: "bad" as const, big: t("kiosk.gate.engine.failed"), small: t("kiosk.gate.engine.failedHint") };
    }
    if (camera.state.status === "starting") {
      return { tone: "busy" as const, big: t("kiosk.gate.camera.starting"), small: null };
    }
    switch (faceState.kind) {
      case "checking":
        return { tone: "busy" as const, big: t("kiosk.gate.scan.capturing"), small: null };
      case "not_recognised":
        return {
          tone: "warn" as const,
          big: t("kiosk.gate.guard.notRecognised"),
          small: t("kiosk.gate.guard.notRecognisedHint"),
        };
      case "unavailable":
        return {
          tone: "warn" as const,
          big: t("kiosk.gate.guard.unavailable"),
          small: t("kiosk.gate.guard.unavailableHint"),
        };
      case "error":
        return { tone: "bad" as const, big: t("kiosk.gate.scan.failed"), small: faceState.detail };
      case "scanning":
        switch (signal.kind) {
          case "many_faces":
            return { tone: "warn" as const, big: t("kiosk.scan.oneAtATime"), small: null };
          case "step_closer":
            return { tone: "warn" as const, big: t("kiosk.scan.stepCloser"), small: null };
          case "guidance":
            return { tone: "warn" as const, big: guidanceLine(signal.verdict), small: null };
          case "tracking":
          case "capturing":
            return { tone: "busy" as const, big: t("kiosk.gate.scan.tracking"), small: null };
          case "idle":
            return {
              tone: "idle" as const,
              big: t("kiosk.gate.guard.scanning"),
              small: t("kiosk.gate.guard.scanningHint"),
            };
        }
    }
  })();

  const pinStep = identity !== null || typing;

  return (
    <GateFrame
      title={t("kiosk.gate.guard.title")}
      subtitle={pinStep ? undefined : t("kiosk.gate.guard.subtitle")}
      footer={
        <span className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("kiosk.gate.guard.security")}
        </span>
      }
    >
      {camera.state.status === "failed" && camera.state.failure !== null ? (
        <CameraProblem failure={camera.state.failure} onRetry={camera.retry} />
      ) : null}

      <Viewfinder
        videoRef={videoRef}
        facing={camera.state.facing}
        dim={!pinStep}
        className={pinStep ? "h-24" : "aspect-[3/4] max-h-[52vh]"}
      >
        {/* A dead camera already has its own card above; two messages about one
            problem is worse than one. */}
        {pinStep || camera.state.status === "failed" ? null : (
          <GateBanner tone={faceBanner.tone} big={faceBanner.big} small={faceBanner.small} />
        )}
      </Viewfinder>

      {pinStep ? (
        <div className="space-y-4">
          {identity !== null ? (
            <div className="rounded-xl border-2 border-emerald-400 bg-emerald-950/70 p-3">
              <p className="font-display text-2xl font-bold leading-tight">
                {t("kiosk.gate.guard.identified", { name: identity.displayName })}
              </p>
              <p className="num mt-1 text-base text-emerald-100">
                {t("kiosk.gate.guard.identifiedHint", { code: identity.employeeCode })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {faceState.kind === "unavailable" ? (
                <p className="rounded-xl border border-amber-400/70 bg-amber-950/60 px-3 py-2 text-base text-amber-100">
                  {t("kiosk.gate.guard.unavailableHint")}
                </p>
              ) : null}
              <label className="block space-y-1.5">
                <span className="text-sm text-neutral-300">{t("kiosk.gate.guard.code")}</span>
                <input
                  value={typedCode}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setTypedCode(e.target.value.toUpperCase())}
                  placeholder="TT0006"
                  className="min-h-14 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 text-center font-display text-xl tracking-wider text-neutral-50 placeholder:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                />
              </label>
            </div>
          )}

          <div className="space-y-2">
            <span className="block text-center text-sm text-neutral-300">
              {t("kiosk.gate.guard.pin")}
            </span>
            <PinDots length={pin.length} />
          </div>
          <Keypad
            onKey={(digit) => setPin((prev) => (prev.length < 10 ? prev + digit : prev))}
            onBackspace={() => setPin((prev) => prev.slice(0, -1))}
          />

          {error !== null ? (
            <p
              className="rounded-lg border border-red-500/60 bg-red-950/60 px-3 py-2 text-base text-red-100"
              aria-live="polite"
            >
              {error}
            </p>
          ) : null}

          <Button
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy || employeeCode === "" || pin.length < 4}
            onClick={() => void submit()}
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 size-5 animate-spin" aria-hidden />
                {t("kiosk.gate.guard.starting")}
              </>
            ) : (
              <>
                <KeyRound className="mr-2 size-5" aria-hidden />
                {t("kiosk.gate.guard.start")}
              </>
            )}
          </Button>

          <button
            type="button"
            onClick={startOver}
            className="min-h-12 w-full text-base text-neutral-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            {identity !== null ? t("kiosk.gate.guard.notYou") : t("kiosk.gate.guard.faceInstead")}
          </button>
          <p className="text-center text-xs leading-snug text-neutral-500">
            {t("kiosk.gate.guard.lockNote")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <CameraChoice
            facing={camera.state.facing}
            canSwitch={camera.canSwitch}
            switching={camera.state.switching}
            notice={camera.state.notice}
            onChoose={camera.chooseFacing}
          />
          <Button
            size="lg"
            variant="outline"
            className="min-h-14 w-full border-neutral-700 bg-transparent text-base text-neutral-100 hover:bg-neutral-800"
            onClick={() => setTyping(true)}
          >
            <Keyboard className="mr-2 size-5" aria-hidden />
            {t("kiosk.gate.guard.typeInstead")}
          </Button>
        </div>
      )}
    </GateFrame>
  );
}
