/**
 * GateScanScreen — the queue. "Then for the rest of the people, he scans using the
 * back camera or the front camera, whichever is possible… It should recognize very
 * quickly and record attendance at the gate."
 *
 * THE CYCLE, with no tap anywhere in it:
 *   track (≈117 ms/frame, detector only) → two stable frames → one capture
 *   (≈356 ms: detector + landmarks + 128-D descriptor) → POST the descriptor →
 *   big card → the card clears itself as soon as the lane is empty (or after nine
 *   seconds if somebody stands there reading it) → track again.
 *
 * While a card is up the loop keeps TRACKING but captures nothing: that is how it
 * knows the person has stepped away, and it is why the guard never has to touch
 * the screen between people.
 *
 * WHAT IS SENT: 128 floats. Never a frame, never a photo. The 1:N match, the
 * thresholds, the debounce and the IN/OUT decision are all `kiosk-punch`'s, in
 * Postgres; this screen prints the four fields it is allowed to see.
 *
 * WHAT IS KEPT: nothing. The last five scans live in React state for the guard's
 * own confidence and die with the page. A gate device holds no HR records.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Database, Gauge, Loader2, LogOut, MapPin, RotateCcw, ScanFace, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nowInstantIso, nowIstClock } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import {
  isDevicePairingDead,
  sendPunch,
  type KioskDeviceState,
  type PunchOutcome,
} from "../lib/deviceAuth";
import { measureLiveness } from "@/features/auth/lib/liveness";
import {
  counts as queueCounts,
  enqueue,
  requestPersistentStorage,
} from "../lib/punchQueue";
import { flushQueue } from "../lib/punchSync";
import { faceBackend } from "../lib/facePipeline";
import {
  GATE_TRACK_INPUT_SIZE,
  LatencyTracker,
  RESULT_HOLD_MAX_MS,
  RESULT_HOLD_MIN_MS,
  runGateLoop,
  type GateSignal,
  type LatencySummary,
} from "../lib/gateScanner";
import { signalLine } from "../lib/gateCopy";
import { CameraProblem } from "../components/GateChrome";
import { GateLiveHeader } from "../components/GateLiveHeader";
import {
  GateBanner,
  GateResultCard,
  RecentScans,
  type BannerTone,
  type RecentScan,
} from "../components/GateResult";
import { Viewfinder } from "../components/Viewfinder";
import { LocalLogSheet } from "../components/LocalLogSheet";
import { useCamera } from "../hooks/useCamera";
import { useNativeCamera } from "../hooks/useNativeCamera";
import { useKioskLocation } from "../hooks/useKioskLocation";
import type { SignInLocationStatus } from "@/features/auth/lib/geolocation";
import { useOperatorHeartbeat } from "../hooks/useOperatorHeartbeat";
import { uuid } from "../lib/uuid";
import { bundleUsable, loadBundle, refreshBundle, type FaceBundle } from "../lib/faceBundle";
import { matchLocally } from "../lib/localMatch";
import { appendRecentScan } from "../lib/recentScans";
import { chimeForOutcome } from "@/shared/audio/chime";
import { announcePunch } from "@/shared/audio/announce";
import type { EngineStatus } from "../lib/engine";

/** How many accepted scans stay on screen. Five fits a phone without scrolling. */
const RECENT_LIMIT = 5;

/**
 * Refusals that mean "this shift is over", not "this scan failed".
 *
 * `_shared/auth.ts` states the contract in its own header:
 * `KIOSK_OPERATOR_SESSION_INVALID` → the kiosk routes to K1 (guard sign-in). It
 * covers an expired 10-minute token, a closed session, a token minted for another
 * kiosk, and a guard deactivated mid-shift. `KIOSK_OPERATOR_SESSION_IDLE` is the
 * 90-minute idle rule, and `NO_OPERATOR` is `sendPunch` refusing locally because
 * the stored state has no token at all.
 *
 * Why this matters at the gate: the token lives ten minutes, so a phone left idle
 * over a tea break has a dead session in localStorage and its FIRST scan on
 * reopening lands here. Printing the server's sentence on the result card would
 * leave the gate refusing every person for up to four minutes — until the
 * heartbeat happened to notice — with no way for the guard to know they simply
 * need to sign in again.
 */
/**
 * Descriptor frames captured per approach on an UNATTENDED gate.
 *
 * Two is the minimum that can be compared at all, and the minimum is the right choice:
 * every extra frame is another ~204 ms descriptor plus a 500 ms wait added to the time a
 * person stands at the gate, and the signal from a third frame is marginal next to the
 * signal from having any second frame at all.
 */
const LIVENESS_FRAMES_UNATTENDED = 2;

/**
 * The score a gate scan must reach. 0.70, matching `attendance.liveness_pass_threshold`,
 * which is what `face-login` already refuses below — the same measurement should not have
 * two different bars in one product.
 */
const LIVENESS_PASS_THRESHOLD = 0.7;

const SESSION_DEAD_CODES: ReadonlySet<string> = new Set([
  "KIOSK_OPERATOR_SESSION_INVALID",
  "KIOSK_OPERATOR_SESSION_IDLE",
  "NO_OPERATOR",
]);

type Phase =
  | { kind: "live" }
  | { kind: "sending" }
  | { kind: "result"; outcome: PunchOutcome; at: number }
  /**
   * Held on the device because the server could not be reached.
   *
   * Deliberately NOT an `error`: the scan succeeded, the person is recorded, and the only
   * thing outstanding is the sync. Rendering it as a failure would send somebody to find a
   * guard over a working punch.
   */
  | {
    kind: "queued";
    at: number;
    /**
     * Who the DEVICE thinks it was, matched against its own bundle while offline.
     *
     * Display only, and the naming says so. The queued punch still carries its descriptor and
     * `kiosk-punch` re-matches against live templates when the queue drains — so a stale
     * bundle can be briefly wrong on this screen and can never be wrong on the record.
     */
    localName?: string;
    localCode?: string;
  }
  | { kind: "error"; detail: string; at: number };

/**
 * The footer's location line.
 *
 * `idle` shares the "asking" copy: the hook fires a fix on mount, so the only way
 * to see `idle` is in the moment before that resolves, and "Finding location…" is
 * what is actually happening. Every other branch tells the guard the scan is still
 * recorded — because it is, and a guard who thinks the gate is broken stops using
 * it.
 */
function locationLine(status: SignInLocationStatus, accuracyMetres: number | null): string {
  switch (status) {
    case "granted":
      return accuracyMetres === null
        ? t("kiosk.gate.location.grantedNoAccuracy")
        : t("kiosk.gate.location.granted", { metres: accuracyMetres });
    case "denied":
      return t("kiosk.gate.location.denied");
    case "unavailable":
      return t("kiosk.gate.location.unavailable");
    case "error":
      return t("kiosk.gate.location.error");
    default:
      return t("kiosk.gate.location.asking");
  }
}

export function GateScanScreen({
  device,
  engine,
  onDeviceState,
  onSignOut,
  onSessionExpired,
  onUnpaired,
}: {
  device: KioskDeviceState;
  engine: EngineStatus;
  onDeviceState: (state: KioskDeviceState) => void;
  onSignOut: () => void;
  onSessionExpired: () => void;
  /** The device's pairing is dead (secret rotated, or device revoked) — re-pair. */
  onUnpaired: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The queue is usually scanned with the back camera, but the choice is the
  // guard's and it survives a reload for the rest of the session.
  /*
    FRONT CAMERA, ALWAYS. No choice offered.

    The gate is wall-mounted and the front camera is the one pointing at the person walking up
    to it. The rear camera faces the wall, so the only thing the switch could do on a mounted
    terminal was break it — and a public screen with a control that breaks it is a control that
    will eventually be pressed.

    `remember: false` deliberately: a stored preference from a build that offered the choice must
    not resurrect the rear camera on a device that has one.
  */
  const camera = useCamera(videoRef, { initial: "user", remember: false });

  /*
    ── THE NATIVE SHELL'S CAMERA, WHEN THERE IS ONE ──────────────────────────────
    Present only inside the iOS app. It exists for one reason: iOS 12 has no
    `getUserMedia` anywhere outside Safari — not in WKWebView, not in a home-screen web app
    — so on the iPad generation that ends at 12.5.7 the shell must hold the camera and the
    web layer must ask it for frames.

    Both hooks are called unconditionally, because hooks must be. `useNativeCamera` reports
    `present: false` in a browser and does nothing at all; `useCamera` fails harmlessly in
    the shell, where there is no `getUserMedia` to succeed with. Which one the loop reads is
    decided below, once, by `native.present`.
  */
  /*
    ── THE OFFLINE FACE BUNDLE ───────────────────────────────────────────────────
    Held in a ref, not state, and that is deliberate: the scan loop reads it on the frame that
    produced a descriptor, and putting a few hundred kilobytes of Float32Arrays into React state
    would re-render the whole screen — and restart the detector — every time it refreshed.

    `bundleReady` IS state, because the footer shows whether this gate can currently work
    offline, and that is worth a render when it changes.
  */
  const bundleRef = useRef<FaceBundle | null>(null);
  const [bundleReady, setBundleReady] = useState(false);
  /*
    WHY it is not ready, shown on screen.

    The footer used to say only "not ready", which is what a bundle that has not downloaded yet
    looks like AND what a server error looks like. When the endpoint was failing on a bad column
    name, the gate reported the same sentence either way and there was no way to tell from the
    device which it was. A machine code in small text is ugly; a feature that silently does not
    work is worse.
  */
  const [bundleProblem, setBundleProblem] = useState<string | null>(null);
  /*
    The last offline match verdict, shown in the footer.

    Because "no name appeared" has four completely different causes and they are
    indistinguishable from the outside: no bundle, nobody close enough, two people too close to
    separate, or a probe of the wrong width. Guessing between them from a description costs a
    round trip each time; the device knows, so it should say.
  */
  const [localVerdict, setLocalVerdict] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  /*
    True while a flush is actually in flight.

    Distinct from "there are items waiting": a gate with a queue and no network is not syncing,
    and showing a spinner then would say the opposite of what is happening. This is set around
    the flush itself so the indicator means exactly one thing.
  */
  const [syncing, setSyncing] = useState(false);
  /*
    The flush is defined inside its own effect, where its cancellation flag lives. The sheet's
    "Sync now" button needs to call exactly that one — a second implementation would be a second
    thing to keep in step, and `flushQueue`'s in-flight guard already makes a double call
    harmless.
  */
  const flushNowRef = useRef<() => void>(() => undefined);

  /** Whether the browser has promised not to evict the queue. See `requestPersistentStorage`. */
  const [storageMode, setStorageMode] = useState<"persisted" | "best-effort" | "unsupported">(
    "unsupported",
  );

  /*
    Ask ONCE, on mount, for storage the browser will not evict.

    IndexedDB already survives the app closing, a reload and a power cycle. What it does not
    survive by default is EVICTION under disk pressure — and on Safari, seven days without a
    visit for anything not installed to the home screen. A gate that queued a morning's arrivals
    and was then closed over a long weekend could lose them silently, which is the one failure
    this whole queue exists to prevent.
  */
  useEffect(() => {
    void requestPersistentStorage().then(setStorageMode).catch(() => undefined);
  }, []);

  const native = useNativeCamera();
  /*
    Destructured so the scan-loop effect can depend on these two rather than on `native`.
    `useNativeCamera` returns a fresh object every render, so listing the object would
    restart the detector on every paint — the churn the notes on that effect's dependency
    array exist to prevent. `nativePresent` is a boolean fixed for the life of the process
    (a page either is or is not inside the shell) and `nativeGrab` is a useCallback keyed
    only to it, so neither can cause a restart.
  */
  const { present: nativePresent, grab: nativeGrab } = native;
  const cameraLive = native.present
    ? native.state.status === "live"
    : camera.state.status === "live";

  const [phase, setPhase] = useState<Phase>({ kind: "live" });

  /**
   * Server-owned; see Kiosk.page.tsx. Undefined means attended.
   *
   * Declared HERE, above every effect that reads it. It was originally next to the JSX,
   * which put it after the scan-loop effect that closes over it — a use-before-declaration
   * that only surfaced once the project was type-checked properly.
   */
  /*
    THE GATE IS ALWAYS UNATTENDED. There is no guard screen any more, so there is no path
    by which a session could exist and nothing for this to vary on.

    It used to read `device.requireOperator === false`, and leaving it that way would have
    been quietly harmful in two places rather than merely untidy: the header would offer an
    "End shift" button for a guard who cannot sign in, and — the real damage — line 289
    would drop `livenessFrames` from two to one, weakening the only check now standing
    between a printed photograph and an attendance record. A stale flag must not be able to
    turn a security control down.
  */
  const unattended = true;

  /** Scans held on this device. Shown in the header so the state is never a surprise. */
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(() => {
    void queueCounts()
      .then(({ pending: n }) => setPending(n))
      .catch(() => undefined);
  }, []);

  const [signal, setSignal] = useState<GateSignal>({ kind: "idle" });
  const [recent, setRecent] = useState<readonly RecentScan[]>([]);
  const [latency, setLatency] = useState<LatencySummary>({
    lastMs: null,
    medianMs: null,
    samples: 0,
  });
  const [scanCount, setScanCount] = useState(0);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);

  const tracker = useMemo(() => new LatencyTracker(), []);

  // The loop must not restart when the phase changes, so it reads the phase from
  // a ref. One render of staleness is worth one uninterrupted detector.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /**
   * The session token, also by ref — and this one is not a nicety.
   *
   * The heartbeat replaces `device` every four minutes. If the loop depended on
   * `device` it would tear down and restart on each refresh, and a punch that was
   * in flight at that moment would return to a cancelled loop, skip its
   * `setPhase`, and leave the screen stuck on "sending" forever — which reads as
   * `paused()` and freezes the replacement loop too. Reading the device from a ref
   * means a token refresh never touches the loop at all.
   */
  const deviceRef = useRef(device);
  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  // Same reason as deviceRef: the loop calls this on a dead session, and taking it
  // as a dependency would tear the detector down whenever the parent re-created
  // its callback.
  const expiredRef = useRef(onSessionExpired);
  useEffect(() => {
    expiredRef.current = onSessionExpired;
  }, [onSessionExpired]);

  /** Same ref treatment: called from inside the loop, must not restart it. */
  const unpairedRef = useRef(onUnpaired);
  useEffect(() => {
    unpairedRef.current = onUnpaired;
  }, [onUnpaired]);

  /**
   * WHERE THIS TABLET IS. One fix, refreshed slowly, read synchronously by the
   * punch — the gate never waits on a GPS.
   *
   * NO REF MIRROR HERE, unlike the three above, and the difference matters:
   * `location.current` is a `useCallback(…, [])`, so its identity never changes
   * even though the fix behind it does. It is therefore a legitimate dependency of
   * the scan loop and cannot restart it — whereas mirroring it into a ref would
   * only have added an effect whose dependency ESLint correctly rejects, since
   * mutating a ref does not re-render.
   */
  const location = useKioskLocation();
  const readLocation = location.current;

  useOperatorHeartbeat({
    device,
    scanCount,
    lastScanAt,
    onRefreshed: onDeviceState,
    onExpired: onSessionExpired,
  });

  /** The card clears itself the moment the lane is empty and the minimum hold has
   * passed. This is the "ready for the next person WITHOUT a tap" requirement. */
  /*
    Load what is already stored, then ask the server for anything newer.

    In that order, and the order matters: a gate that boots with no internet must be able to
    recognise people from the bundle it already has, so the stored copy is adopted before the
    network is attempted at all. An expired bundle is loaded and then rejected by
    `bundleUsable`, which is what makes a long outage degrade to "cannot name people" rather
    than to naming them from data the device can no longer vouch for.
  */
  useEffect(() => {
    let cancelled = false;

    const adopt = (next: FaceBundle | null, problem?: string) => {
      if (cancelled) return;
      bundleRef.current = next;
      setBundleReady(bundleUsable(next));
      setBundleProblem(problem ?? null);
    };

    void loadBundle().then((stored) => {
      adopt(stored);
      // The server call is fire-and-forget: it cannot fail in a way that should stop scanning.
      void refreshBundle(deviceRef.current)
        .then((outcome) =>
          adopt(
            outcome.bundle,
            // "offline" is not a fault worth naming: it is the state this whole feature is for.
            outcome.kind === "refused" ? (outcome.code ?? "REFUSED") : undefined,
          ),
        )
        .catch(() => adopt(null, "FETCH_FAILED"));
    });

    /*
      Refresh when the network comes back, so an enrolment made during the outage is available
      the moment it can be. Listening to `online` rather than polling: a wall terminal may sit
      untouched for days and a timer would spend that whole time asking a server it cannot see.
    */
    const onOnline = () => {
      void refreshBundle(deviceRef.current)
        .then((outcome) =>
          adopt(
            outcome.bundle,
            outcome.kind === "refused" ? (outcome.code ?? "REFUSED") : undefined,
          ),
        )
        .catch(() => adopt(null, "FETCH_FAILED"));
    };
    window.addEventListener("online", onOnline);

    /*
      And on a timer, so a NEW ENROLMENT reaches the gate by itself.

      `online` only fires when the link changes. A terminal that has been up for a week with
      steady wifi never fires it again, so somebody enrolled this morning would not be
      recognisable offline until the tablet was reloaded by hand. Fifteen minutes; the request
      is a version check that answers "unchanged" in a few hundred bytes almost every time.
    */
    const timer = window.setInterval(onOnline, 15 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  /*
    Advertise "a punch is in flight" on the document, for the service-worker reload to respect.
    See `reloadWhenReplaced` in src/kiosk/registerKioskServiceWorker.ts.

    On the body rather than in React state because the reader is outside React entirely — a
    worker message handler registered before the app mounted. A dataset flag is the smallest
    thing both can see, and it costs one attribute write per punch.
  */
  useEffect(() => {
    const busy = phase.kind === "sending";
    document.body.dataset["ttGateBusy"] = busy ? "true" : "false";
    return () => {
      delete document.body.dataset["ttGateBusy"];
    };
  }, [phase.kind]);

  const clearIfLaneEmpty = useCallback(() => {
    setPhase((prev) => {
      /*
        "queued" BELONGS IN THIS LIST, AND ITS ABSENCE WAS A BUG.

        It was omitted, so a gate that took a punch while offline sat on the queued card
        forever: the lane emptying cleared a result and an error but not this, and the only way
        back to scanning was somebody reloading the page. Reported from the field as "offline
        works but needs a manual refresh every time" — which is exactly what it was.

        An offline punch is a completed outcome like any other. It holds for the same minimum,
        then the terminal goes back to scanning by itself.
      */
      if (prev.kind !== "result" && prev.kind !== "error" && prev.kind !== "queued") return prev;
      return performance.now() - prev.at >= RESULT_HOLD_MIN_MS ? { kind: "live" } : prev;
    });
  }, []);

  const scanning = engine.kind === "ready" && cameraLive;

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    // Heal a "sending" left behind by a previous loop that was torn down mid-punch:
    // the punch itself is already recorded server-side, and a stuck pause here
    // would stop the gate dead.
    setPhase((prev) => (prev.kind === "sending" ? { kind: "live" } : prev));
    void runGateLoop({
      /*
        One accessor, two sources. In the shell each iteration pulls a fresh frame across
        the bridge; in a browser the <video> is already live and this resolves immediately.
        The loop cannot tell the difference, and neither can `readFrame` — which is the
        point, because the descriptor has to come out identical either way.
      */
      video: nativePresent
        ? () => nativeGrab()
        : () => Promise.resolve(videoRef.current),
      paused: () => phaseRef.current.kind === "sending",
      capture: () => phaseRef.current.kind === "live",
      /*
        An unattended gate measures liveness; an attended one does not.

        The guard IS the liveness check on an attended gate — a person watching cannot be
        fooled by a phone held up at the camera — so paying for a second descriptor there
        buys nothing and slows the queue. Remove the guard and that defence goes with them,
        so the terminal has to measure it itself.
      */
      livenessFrames: unattended ? LIVENESS_FRAMES_UNATTENDED : 1,
      cancelled: () => cancelled,
      onSignal: (next) => {
        if (cancelled) return;
        setSignal(next);
        if (next.kind === "idle") clearIfLaneEmpty();
      },
      onReading: async (reading, firstSeenAt, window) => {
        if (cancelled) return;

        /*
          ── LIVENESS, ON AN UNATTENDED GATE ONLY ──────────────────────────────
          Enforced HERE rather than on the server, and that is a deliberate limitation
          worth stating: `kiosk-punch` has no metrics field and a `.strict()` schema, so a
          liveness score cannot be sent with a punch today. Adding one is a schema change,
          a column and a migration — a follow-up, not part of this change.

          What this does stop is the threat that actually exists at an unattended gate: an
          employee holding up a photograph of a colleague. `measureLiveness` scores a still
          image at ~0 because a printed face has no descriptor drift, no pose change and no
          framing change between frames. What it does NOT stop is a modified client, and
          nothing client-side can — that is what device revocation in
          `/admin/kiosk/devices` is for.
        */
        let liveness: ReturnType<typeof measureLiveness> | null = null;
        if (unattended) {
          liveness = measureLiveness(
            window.map((r) => ({
              descriptor: r.descriptor,
              yaw: r.quality.yaw,
              pitch: r.quality.pitch,
              roll: r.quality.roll,
              box: r.box,
            })),
          );
          if (liveness.score < LIVENESS_PASS_THRESHOLD) {
            // Deliberately not "you look like a photograph". A real person who held
            // unusually still gets the same message, and telling somebody how they failed
            // a liveness check is telling them how to pass it.
            setPhase({
              kind: "error",
              detail: t("kiosk.gate.livenessRetry"),
              at: performance.now(),
            });
            return;
          }
        }

        setPhase({ kind: "sending" });
        // `current()` is synchronous and may be null — the punch is sent either
        // way. A gate that waited on a GPS fix would stall the queue, and a punch
        // withheld for want of coordinates would lose the attendance entirely.
        /*
          Captured ONCE, before the send, and reused by the queue on failure.

          `readLocation()` and the capture instant must not be re-read in the failure
          branch: a punch queued at 08:57 that recorded the time it failed at 08:59, or the
          location the tablet had after being carried indoors, is a punch with the wrong
          facts on it.
        */
        const capturedAt = nowInstantIso();
        const geo = readLocation() ?? undefined;
        const metrics =
          liveness === null
            ? undefined
            : {
                detectionScore: reading.quality.detection_score,
                livenessScore: liveness.score,
                livenessModel: liveness.model,
                framesAnalysed: liveness.framesAnalysed,
              };

        const result = await sendPunch(
          deviceRef.current,
          reading.descriptor,
          undefined,
          geo ?? null,
          /*
            Sent so the SERVER can refuse too, not only this screen.

            The check above stops a photograph at the gate; this makes the same decision
            enforceable where it cannot be bypassed by a modified client, and writes the
            score to `secure.face_match_log.liveness_score` as evidence. `kiosk-punch`
            requires it whenever the device is unattended.
          */
          metrics ?? null,
        );
        if (cancelled) return;
        // The number the client asked for: the first frame that saw this face, to
        // the card being on screen.
        tracker.add(performance.now() - firstSeenAt);
        setLatency(tracker.summary());
        if (!result.ok) {
          // The PAIRING is dead, not just the shift — an admin re-issued a code and
          // rotated this device's secret out from under it. Guard sign-in would fail
          // the same way, so the only useful destination is pairing.
          if (isDevicePairingDead(result.error.code)) {
            unpairedRef.current();
            return;
          }
          // The shift is over, not the scan: back to guard sign-in, which is where
          // the guard can actually fix it (SESSION_DEAD_CODES above).
          if (SESSION_DEAD_CODES.has(result.error.code)) {
            expiredRef.current();
            return;
          }
          /*
            ── UNREACHABLE IS NOT REFUSED ────────────────────────────────────────
            The distinction the whole offline story turns on. `status === 0` is this
            client's marker for "could not reach the server"; a 5xx is the server failing
            rather than the scan being wrong. Neither says anything about the person
            standing at the gate, so the scan is HELD rather than lost, with its real
            capture time, and `kiosk-punch` replays it later keeping that instant as
            `punched_at`. Nobody is marked late because the router rebooted.

            A 4xx is different and is NOT queued: the server looked at this scan and
            refused it, and asking again with the same bytes will get the same answer.
            Queueing it would fill the device with scans that can never succeed.
          */
          const unreachable = result.error.status === 0 || result.error.status >= 500;
          if (unreachable) {
            let localName: string | undefined;
            let localCode: string | undefined;
            let localEmployeeId: string | undefined;
            const bundle = bundleRef.current;
            if (bundle === null) {
              setLocalVerdict("no bundle on this device");
            } else {
              const local = matchLocally(bundle, reading.descriptor);
              /*
                Recorded for every outcome, not only failures. "matched" in the footer is how
                somebody confirms offline recognition is genuinely working rather than inferring
                it from a name that might have come from anywhere.
              */
              setLocalVerdict(
                local.kind === "matched"
                  ? `matched ${local.displayName} (${(local.confidence * 100).toFixed(0)}%)`
                  : local.kind === "no_match"
                    ? `no match — best ${local.bestConfidence === null ? "n/a" : (local.bestConfidence * 100).toFixed(0) + "%"} of ${bundle.people.length} faces`
                    : local.kind === "ambiguous"
                      ? `too close to call — margin ${local.margin.toFixed(3)}`
                      : `unusable bundle — ${bundle.people.length} faces, expires ${bundle.expiresAt.slice(0, 10)}`,
              );
              if (local.kind === "matched") {
                localName = local.displayName;
                localCode = local.employeeCode;
                localEmployeeId = local.employeeId;
                // Logged like any other punch, so the tail shows the outage's arrivals rather
                // than a gap. `punchKind` is left as "scan": the direction is the server's
                // ordinal and this device cannot know it while it cannot see the punch log.
                setRecent((prev) =>
                  appendRecentScan(
                    prev,
                    {
                      matched: true,
                      displayName: local.displayName,
                      employeeCode: local.employeeCode,
                      punchKind: "scan",
                      istTime: nowIstClock(nowInstantIso()),
                    },
                    uuid(),
                    RECENT_LIMIT,
                  ),
                );
              }
            }

            const queued = await enqueue({
              clientEventId: uuid(),
              capturedAt: capturedAt,
              queuedAt: nowInstantIso(),
              descriptor: [...reading.descriptor],
              ...(geo ? { geo } : {}),
              ...(metrics ? { metrics } : {}),
              /*
                The device's own identification travels WITH the punch. Two uses, both honest:
                it labels this scan in the on-device log and the sync history, and the server may
                use it as a HINT to verify 1:1 when its own 1:N cannot separate two people —
                rescuing attendance that would otherwise be refused, flagged for review.
              */
              ...(localName !== undefined ? { localName } : {}),
              ...(localEmployeeId !== undefined ? { localEmployeeId } : {}),
            })
              .then(() => true)
              .catch(() => false);

            setOnline(false);
            refreshPending();

            /*
              ── NAME THEM, EVEN WITH NO INTERNET ──────────────────────────────────
              Until now this branch recorded a scan blind: the descriptor was held, the screen
              said "saved", and nobody — then or later — could tell who had walked through. The
              on-screen log stayed empty for the whole outage.

              The bundle makes the terminal able to answer. `matchLocally` mirrors the server's
              rules exactly and refuses rather than guesses, because an offline gate is where a
              wrong name does the most damage: nobody is watching, the person leaves satisfied,
              and the error only surfaces when the queue drains.

              Failure here changes nothing that matters — the punch is already queued.
            */
            // If the queue itself could not accept it, say so plainly. A gate that
            // silently drops an arrival is worse than one that admits it cannot.
            setPhase(
              queued
                ? {
                  kind: "queued",
                  at: performance.now(),
                  ...(localName !== undefined ? { localName } : {}),
                  ...(localCode !== undefined ? { localCode } : {}),
                }
                : { kind: "error", detail: t("kiosk.gate.queueFull"), at: performance.now() },
            );
            /*
              A held scan gets its own sound, not the success one. For the person at the gate
              it IS a success — they are recorded and can walk on — but a gate that sounded
              identical whether it reached the server or not would hide an outage for as long
              as nobody happened to look at the screen.
            */
            /*
              A held scan is announced as held, not as recorded. For the person at the gate it
              IS a success — they can walk on — but they are entitled to know it has not
              reached the server, and a gate that sounded identical either way would hide an
              outage for as long as nobody read the screen.
            */
            announcePunch(
              queued ? "queued" : "error",
              queued ? t("kiosk.gate.say.queued") : t("kiosk.gate.say.problem"),
            );
            return;
          }

          setPhase({ kind: "error", detail: result.error.detail, at: performance.now() });
          /*
            A transport or server failure, NOT a rejected face. It gets the alarm and the
            generic line: telling somebody "authentication failed" when the gate could not
            reach the server would send them back to the camera to re-scan a face that was
            never the problem.
          */
          announcePunch("error", t("kiosk.gate.say.problem"));
          return;
        }
        setPhase({ kind: "result", outcome: result.data, at: performance.now() });
        /*
          The sound people are actually listening for. `chimeForOutcome` decides, in one shared
          place, so the gate and the web punch cannot drift into disagreeing about what a
          duplicate sounds like — and so a debounced re-scan does not sound like a second
          successful punch to somebody who scanned twice.
        */
        /*
          THE SPOKEN CONFIRMATION, AND WHY THE DIRECTION IS THE POINT.

          `punchKind` is the server's own ordinal for the day — first live scan is "in", second
          is "out", later ones are "scan" with no direction. Saying which one aloud is the only
          way the person walking through can catch the gate having recorded the wrong thing,
          and they cannot catch it by reading a screen they are already past.

          Never inferred locally. The direction is computed server-side from the punches that
          actually exist, and a client guess would eventually contradict the record — the worst
          possible outcome for a sentence whose entire job is to be trusted.
        */
        const kind = chimeForOutcome(result.data);
        const spoken =
          kind === "duplicate"
            ? t("kiosk.gate.say.duplicate")
            : kind === "recorded"
              ? result.data.punchKind === "in"
                ? t("kiosk.gate.say.in")
                : result.data.punchKind === "out"
                  ? t("kiosk.gate.say.out")
                  : t("kiosk.gate.say.scan")
              : // Not matched: the face was read and belonged to nobody on file. This is the
                // one case that is genuinely an authentication failure, and the only one that
                // is fixed by the person stepping up and scanning again.
                t("kiosk.gate.say.failed");
        announcePunch(kind, spoken);
        setScanCount((prev) => prev + 1);
        setLastScanAt(nowInstantIso());
        /*
          The tail lists PUNCHES, not scan attempts — a suppressed re-scan is answered from the
          original punch, and appending that answer is what printed one punch on two rows at the
          same second. The rule lives in `appendRecentScan` so it can be tested directly.
        */
        setRecent((prev) => appendRecentScan(prev, result.data, uuid(), RECENT_LIMIT));
      },
    }).catch(() => {
      if (!cancelled) {
        setPhase({ kind: "error", detail: t("kiosk.gate.engine.failedHint"), at: performance.now() });
      }
    });
    return () => {
      cancelled = true;
    };
    // `device` is deliberately absent: see deviceRef above.
    // `readLocation` is stable (see above), so listing it satisfies the linter
    // without ever restarting the detector.
    // `unattended` IS listed, and cannot cause churn: it is a boolean read from the
    // device row, so it holds the same value for the life of a pairing. On the one
    // occasion it does flip — an admin switching the gate between attended and
    // unattended — restarting the loop is exactly right, because the number of
    // descriptor frames per approach changes with it.
    // `refreshPending` is a stable useCallback with no deps, so listing it satisfies the
    // linter without ever restarting the detector — the same argument as `readLocation`.
    // `nativePresent` and `nativeGrab` are listed in place of the `native` object, which is
    // rebuilt every render; see the note where they are destructured. Both are stable, so
    // they satisfy the linter without ever restarting the detector.
  }, [
    scanning,
    tracker,
    clearIfLaneEmpty,
    readLocation,
    unattended,
    refreshPending,
    nativePresent,
    nativeGrab,
  ]);

  // Backstop for somebody who stands in front of the camera reading their own
  // name: the card goes even if the lane never clears.
  useEffect(() => {
    // "queued" listed here for the same reason as above — and this is the path that saves a
    // wall-mounted terminal whose lane never "empties" because nobody walks past it.
    if (phase.kind !== "result" && phase.kind !== "error" && phase.kind !== "queued") return;
    const id = window.setTimeout(() => setPhase({ kind: "live" }), RESULT_HOLD_MAX_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  const banner = useMemo((): { tone: BannerTone; big: string; small: string | null } | null => {
    if (engine.kind === "loading") {
      return {
        tone: "busy",
        big: t("kiosk.gate.engine.loading"),
        small: t("kiosk.gate.engine.loadingHint"),
      };
    }
    if (engine.kind === "failed") {
      return {
        tone: "bad",
        big: t("kiosk.gate.engine.failed"),
        small: t("kiosk.gate.engine.failedHint"),
      };
    }
    if (camera.state.status === "starting") {
      return { tone: "busy", big: t("kiosk.gate.camera.starting"), small: null };
    }
    // A dead camera already has its own card above the viewfinder.
    if (camera.state.status === "failed") return null;
    switch (phase.kind) {
      case "sending":
        return { tone: "busy", big: t("kiosk.gate.scan.sending"), small: null };
      case "error":
        return { tone: "bad", big: t("kiosk.gate.scan.failed"), small: phase.detail };
      case "result":
        if (phase.outcome.matched) return null; // the result CARD replaces the banner
        return {
          tone: "warn",
          big: t("kiosk.gate.scan.noMatch"),
          small: (phase.outcome.guardConfirmOptions?.length ?? 0) > 0
            ? t("kiosk.gate.scan.ambiguousHint")
            : t("kiosk.gate.scan.noMatchHint"),
        };
      /*
        A held scan is GOOD news presented calmly. Not "warn", because nothing is wrong
        with the person or the gate; the punch exists and carries the right time. The tone
        is the same one an accepted match uses so a queue does not read a green result and
        an amber one as different outcomes.
      */
      case "queued":
        /*
          Name them when the device worked it out from its own bundle. The person at the gate
          gets the same confirmation they would online — which is the whole point of holding the
          faces locally — and the wording still says the punch has not reached the server.
        */
        return {
          tone: "good",
          big: phase.localName !== undefined
            ? t("kiosk.gate.queuedNamed", { name: phase.localName })
            : t("kiosk.gate.queued"),
          small: t("kiosk.gate.queuedHint"),
        };
      case "live": {
        const tone: BannerTone = signal.kind === "many_faces" || signal.kind === "step_closer"
          ? "warn"
          : signal.kind === "idle"
          ? "idle"
          : "busy";
        return {
          tone,
          big: signalLine(signal),
          small: signal.kind === "idle" ? t("kiosk.gate.scan.promptHint") : null,
        };
      }
    }
  }, [engine.kind, camera.state.status, phase, signal]);

  /*
    Whether the gate can reach the server right now.
    `navigator.onLine` is a weak signal — it reports the link, not reachability — so it
    is the starting value and the events refine it. It is deliberately NOT the only
    input later: once the offline queue exists, a failed submit is stronger evidence of
    being offline than the flag is of being online.
  */
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  /*
    ── WHEN A FLUSH IS ATTEMPTED ─────────────────────────────────────────────────
    On mount (a terminal that was power-cycled mid-outage comes back holding scans), on
    the `online` event, when the tab becomes visible again, and on a slow timer as the
    backstop — `navigator.onLine` reports the link rather than reachability, so a gate
    behind a captive portal or a dead upstream never fires an `online` event at all and
    the timer is the only thing that recovers it.

    `flushQueue` guards against overlap itself, so all four triggers firing at once is
    harmless.
  */
  useEffect(() => {
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      setSyncing(true);
      void flushQueue(deviceRef.current)
        .then((outcome) => {
          if (cancelled) return;
          if (outcome.skipped) return;
          setPending(outcome.pending);
          // The lamp follows what the network actually did, not what the browser claims.
          if (outcome.sent > 0) setOnline(true);
          /*
            `rateLimited` deliberately does NOT touch the lamp. The device has run out of its
            replay allowance and the same bytes will succeed in a moment — telling the person at
            the door that the gate is disconnected would be a false story about the network.
          */
          else if (outcome.offline) setOnline(false);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setSyncing(false);
        });
    };
    flushNowRef.current = attempt;

    refreshPending();
    attempt();

    const onOnline = () => attempt();
    const onVisible = () => {
      if (document.visibilityState === "visible") attempt();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(attempt, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refreshPending]);

  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-50">
      {/*
        The standing header. On an unattended gate there is no guard to name and no
        shift to end, so both disappear rather than render a button that strands a
        wall-mounted terminal nobody has a PIN for.
      */}
      <GateLiveHeader
        deviceName={t("kiosk.gate.deviceChip", { device: device.deviceName })}
        operatorName={
          unattended ? undefined : t("kiosk.gate.guardChip", { name: device.operatorName ?? "" })
        }
        online={online}
        pendingCount={pending}
        action={
          unattended ? null : (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 border-neutral-700 bg-transparent text-neutral-100 hover:bg-neutral-800"
              onClick={onSignOut}
            >
              <LogOut className="mr-1.5 size-4" aria-hidden />
              {t("kiosk.gate.endShift")}
            </Button>
          )
        }
      />

      <main className="flex flex-1 flex-col gap-3 px-3 py-3">
        {camera.state.status === "failed" && camera.state.failure !== null ? (
          <CameraProblem failure={camera.state.failure} onRetry={camera.retry} />
        ) : null}

        <Viewfinder
          native={nativePresent}
          videoRef={videoRef}
          facing={camera.state.facing}
          dim
          className="aspect-[3/4] max-h-[56vh] w-full"
        >
          {phase.kind === "result" && phase.outcome.matched ? (
            <GateResultCard outcome={phase.outcome} />
          ) : banner !== null ? (
            <GateBanner tone={banner.tone} big={banner.big} small={banner.small} />
          ) : null}
        </Viewfinder>

        {/*
          ── RELOAD, WHERE THE CAMERA SWITCH USED TO BE ──────────────────────────
          Deliberately large and always visible, and it replaces rather than joins the camera
          chooser: this is the control that matters on a mounted terminal.

          A browser has a reload button in its chrome. An INSTALLED gate does not — the whole
          point of `display: fullscreen` is that there is no address bar — so until now a
          terminal that wedged, or that got slow after a failed scan, had no way back short of
          somebody force-quitting the app. That is the one recovery a person at the door can
          perform without knowing anything, so it belongs on the screen.

          `location.reload()` and nothing cleverer. Re-mounting React would leave the camera
          track, the face engine and the scan loop exactly as wedged as they were; a document
          reload is the only thing that genuinely starts over. Nothing is lost: the pairing is in
          localStorage and held punches are in IndexedDB, both of which survive it.
        */}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex min-h-14 w-full items-center justify-center gap-2.5 rounded-xl border border-neutral-700 bg-neutral-800/80 px-4 text-base font-semibold text-neutral-100 active:bg-neutral-700"
        >
          <RotateCcw className="size-5 shrink-0" aria-hidden />
          {t("kiosk.gate.reload")}
        </button>
        <p className="px-1 text-[11px] leading-snug text-neutral-500">
          {t("kiosk.gate.reloadHint")}
        </p>

        <RecentScans scans={recent} />
      </main>

      <footer className="space-y-1.5 border-t border-neutral-800 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-xs text-neutral-400">
        <p className="flex items-center gap-2">
          <Gauge className="size-4 shrink-0" aria-hidden />
          <span className="font-semibold text-neutral-300">{t("kiosk.gate.speed.label")}</span>
          <span className="num">
            {latency.lastMs === null || latency.medianMs === null
              ? t("kiosk.gate.speed.waiting")
              : `${t("kiosk.gate.speed.value", {
                last: latency.lastMs,
                median: latency.medianMs,
              })} ${t("kiosk.gate.speed.samples", { n: latency.samples })}`}
          </span>
          {/* The backend is the single biggest factor in how fast a scan feels, and
              it is decided by the device, not by us — a phone with a blocklisted GPU
              silently falls back to the CPU path. Showing it turns "the gate is slow
              today" into an answerable question. */}
          <span className="ml-auto shrink-0 text-neutral-500">
            {t("kiosk.gate.speed.detector", { size: GATE_TRACK_INPUT_SIZE })}
            {faceBackend() === null ? "" : ` · ${faceBackend() ?? ""}`}
          </span>
        </p>
        {/*
          WHERE, shown next to HOW FAST. Every state here is non-blocking: the copy
          says "scans still recorded" precisely so a guard who sees a location
          warning does not stop working, and so nobody later assumes a punch with
          no coordinates was rejected.
        */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <MapPin className="size-4 shrink-0" aria-hidden />
          <span className={location.status === "granted" ? "text-neutral-300" : undefined}>
            {locationLine(location.status, location.accuracyMetres)}
          </span>
          {location.status === "denied" ||
          location.status === "error" ||
          location.status === "unavailable" ? (
            <button
              type="button"
              onClick={() => {
                void location.refresh();
              }}
              className="underline underline-offset-4"
            >
              {t("kiosk.gate.location.retry")}
            </button>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 shrink-0" aria-hidden />
            {t("kiosk.gate.rule")}
          </span>
          {/*
            A plain anchor below, not a router Link.

            The gate is its own installed app now, served from its own entry point; the
            enrolment desk lives in the HR app. A router Link would try to resolve
            `/admin/...` inside the gate's own bundle, which has no such route — and it
            would drag react-router into a bundle that otherwise needs none. A full
            document navigation is what crossing from one app to the other actually is.
          */}
          {device.canEnrolFaces === true ? (
            <a href="/admin/kiosk/enrolment" className="underline-offset-4 hover:underline">
              {t("kiosk.scan.enrolLink")}
            </a>
          ) : (
            <span className="flex items-center gap-2">
              <Camera className="size-4 shrink-0" aria-hidden />
              {t("kiosk.scan.enrolNote")}
            </span>
          )}
        </p>

        {/*
          Whether this terminal could name somebody with no internet.

          Worth a line of its own because it is otherwise invisible until the moment it matters,
          and by then there is no internet to fix it with. A gate showing "offline recognition
          off" needs a few seconds of connection before it is mounted on a wall — knowing that
          in advance is the whole point of saying it.
        */}
        <p className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
          <Camera className="size-3.5 shrink-0" aria-hidden />
          {bundleReady
            ? t("kiosk.gate.offlineReady", { count: String(bundleRef.current?.people.length ?? 0) })
            : bundleProblem !== null
              ? t("kiosk.gate.offlineFailed", { code: bundleProblem })
              : t("kiosk.gate.offlineNotReady")}
        </p>

        {/*
          The last offline match, in the gate's own words. Only after one has happened, so a
          terminal that has never scanned offline shows nothing rather than a puzzling blank
          verdict.
        */}
        {/*
          The way in, and the sync indicator, in one control.

          A gate is a public screen, so the log is behind a deliberate tap rather than on the
          wall. The count is on the button because "is anything stuck here?" is the question
          somebody walking past actually has, and it should be answerable without opening
          anything.
        */}
        <button
          type="button"
          onClick={() => setLogOpen(true)}
          className="mt-1 inline-flex items-center gap-2 rounded-lg px-1 py-1 text-[11px] text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
        >
          {syncing ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-400" aria-hidden />
          ) : (
            <Database className="size-3.5 shrink-0" aria-hidden />
          )}
          {syncing
            ? t("kiosk.gate.log.syncing")
            : t("kiosk.gate.log.open", { count: String(pending) })}
          {storageMode === "persisted" ? (
            <span className="text-emerald-500">{t("kiosk.gate.log.persisted")}</span>
          ) : storageMode === "best-effort" ? (
            <span className="text-amber-500">{t("kiosk.gate.log.notPersisted")}</span>
          ) : null}
        </button>

        {localVerdict !== null ? (
          <p className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
            <ScanFace className="size-3.5 shrink-0" aria-hidden />
            {t("kiosk.gate.offlineLastMatch", { verdict: localVerdict })}
          </p>
        ) : null}
      </footer>

      {logOpen ? (
        <LocalLogSheet
          syncing={syncing}
          onClose={() => setLogOpen(false)}
          onSyncNow={() => flushNowRef.current()}
        />
      ) : null}
    </div>
  );
}
