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
import { Link } from "react-router-dom";
import { Camera, Gauge, LogOut, MapPin, ScanFace, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nowInstantIso } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import {
  isDevicePairingDead,
  sendPunch,
  type KioskDeviceState,
  type PunchOutcome,
} from "../lib/deviceAuth";
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
import { CameraChoice } from "../components/CameraChoice";
import { CameraProblem, IstClock } from "../components/GateChrome";
import {
  GateBanner,
  GateResultCard,
  RecentScans,
  type BannerTone,
  type RecentScan,
} from "../components/GateResult";
import { Viewfinder } from "../components/Viewfinder";
import { useCamera } from "../hooks/useCamera";
import { useKioskLocation } from "../hooks/useKioskLocation";
import type { SignInLocationStatus } from "@/features/auth/lib/geolocation";
import { useOperatorHeartbeat } from "../hooks/useOperatorHeartbeat";
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
const SESSION_DEAD_CODES: ReadonlySet<string> = new Set([
  "KIOSK_OPERATOR_SESSION_INVALID",
  "KIOSK_OPERATOR_SESSION_IDLE",
  "NO_OPERATOR",
]);

type Phase =
  | { kind: "live" }
  | { kind: "sending" }
  | { kind: "result"; outcome: PunchOutcome; at: number }
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
  const camera = useCamera(videoRef, { initial: "environment", remember: true });

  const [phase, setPhase] = useState<Phase>({ kind: "live" });
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
  const clearIfLaneEmpty = useCallback(() => {
    setPhase((prev) => {
      if (prev.kind !== "result" && prev.kind !== "error") return prev;
      return performance.now() - prev.at >= RESULT_HOLD_MIN_MS ? { kind: "live" } : prev;
    });
  }, []);

  const scanning = engine.kind === "ready" && camera.state.status === "live";

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    // Heal a "sending" left behind by a previous loop that was torn down mid-punch:
    // the punch itself is already recorded server-side, and a stuck pause here
    // would stop the gate dead.
    setPhase((prev) => (prev.kind === "sending" ? { kind: "live" } : prev));
    void runGateLoop({
      video: () => videoRef.current,
      paused: () => phaseRef.current.kind === "sending",
      capture: () => phaseRef.current.kind === "live",
      cancelled: () => cancelled,
      onSignal: (next) => {
        if (cancelled) return;
        setSignal(next);
        if (next.kind === "idle") clearIfLaneEmpty();
      },
      onReading: async (reading, firstSeenAt) => {
        if (cancelled) return;
        setPhase({ kind: "sending" });
        // `current()` is synchronous and may be null — the punch is sent either
        // way. A gate that waited on a GPS fix would stall the queue, and a punch
        // withheld for want of coordinates would lose the attendance entirely.
        const result = await sendPunch(
          deviceRef.current,
          reading.descriptor,
          undefined,
          readLocation(),
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
          setPhase({ kind: "error", detail: result.error.detail, at: performance.now() });
          return;
        }
        setPhase({ kind: "result", outcome: result.data, at: performance.now() });
        setScanCount((prev) => prev + 1);
        setLastScanAt(nowInstantIso());
        if (result.data.matched) {
          setRecent((prev) =>
            [
              {
                id: crypto.randomUUID(),
                displayName: result.data.displayName ?? "",
                employeeCode: result.data.employeeCode ?? "",
                punchKind: result.data.punchKind ?? "scan",
                istTime: result.data.istTime ?? "",
              },
              ...prev,
            ].slice(0, RECENT_LIMIT),
          );
        }
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
  }, [scanning, tracker, clearIfLaneEmpty, readLocation]);

  // Backstop for somebody who stands in front of the camera reading their own
  // name: the card goes even if the lane never clears.
  useEffect(() => {
    if (phase.kind !== "result" && phase.kind !== "error") return;
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

  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-50">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ScanFace className="size-6 shrink-0 text-emerald-400" aria-hidden />
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-semibold leading-tight">
              {t("kiosk.gate.deviceChip", { device: device.deviceName })}
            </p>
            <p className="truncate text-xs text-neutral-400">
              {t("kiosk.gate.guardChip", { name: device.operatorName ?? "" })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <IstClock className="text-lg" />
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 border-neutral-700 bg-transparent text-neutral-100 hover:bg-neutral-800"
            onClick={onSignOut}
          >
            <LogOut className="mr-1.5 size-4" aria-hidden />
            {t("kiosk.gate.endShift")}
          </Button>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-3 py-3">
        {camera.state.status === "failed" && camera.state.failure !== null ? (
          <CameraProblem failure={camera.state.failure} onRetry={camera.retry} />
        ) : null}

        <Viewfinder
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

        <CameraChoice
          facing={camera.state.facing}
          canSwitch={camera.canSwitch}
          switching={camera.state.switching}
          notice={camera.state.notice}
          onChoose={camera.chooseFacing}
        />

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
          {device.canEnrolFaces === true ? (
            <Link to="/admin/kiosk/enrolment" className="underline-offset-4 hover:underline">
              {t("kiosk.scan.enrolLink")}
            </Link>
          ) : (
            <span className="flex items-center gap-2">
              <Camera className="size-4 shrink-0" aria-hidden />
              {t("kiosk.scan.enrolNote")}
            </span>
          )}
        </p>
      </footer>
    </div>
  );
}
