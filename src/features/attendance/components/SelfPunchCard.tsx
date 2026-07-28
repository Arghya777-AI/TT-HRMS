/**
 * SelfPunchCard — the punch button in the employee's own portal.
 *
 * This is the thing the client described: one button on /me that takes
 * attendance by face, with a location, without walking to the gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE PIPELINE, ONE CONSISTENCY GATE, ONE LIVENESS SIGNAL — NONE OF THEM MINE
 * ─────────────────────────────────────────────────────────────────────────────
 * `features/kiosk/lib/facePipeline.ts` is imported, not copied: it is the SAME
 * detector, the same client gates (score 0.6 / 120 px / brightness 0.18 /
 * sharpness 60) and the same L2-normalised descriptor that the gate kiosk, face
 * sign-in and the enrolment console send, which is the only reason a distance
 * measured here means what the server's threshold says it means. The multi-frame
 * gate is `features/auth/lib/faceConsistency.ts` and the motion score is
 * `features/auth/lib/liveness.ts`, both unchanged and unforked. The pipeline's
 * own guidance sentences are rendered verbatim from the sign-in catalogue, so
 * "Come a little closer to the camera." is the same sentence at every surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT FEELS INSTANT (and what the floor actually is)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. `loadFaceModels()` is called when the CARD MOUNTS, not when the button is
 *     tapped: the ~1.3 MB `chunk-face` and the three weight files are warm
 *     before anyone touches anything, which is the single biggest win available.
 *     It is fired only for an employee who may actually punch, so nobody else
 *     pays for the download.
 *  2. The capture loop keeps exactly ONE `readFrame` in flight. It is a `for(;;)`
 *     with `await`s, not a `setInterval`: the next frame is scheduled only after
 *     the previous verdict, so two detectors can never compete for the CPU and
 *     `framesAnalysed` cannot drift from the frames actually judged. Every await
 *     yields the thread — nothing here blocks paint.
 *  3. The camera is released BEFORE the round trip; the decision is already made.
 *
 * The frame cadence stays at ~500 ms ON PURPOSE and must not be lowered to look
 * faster: `liveness.ts` calibrates its three knees (descriptor 0.06, pose 0.5°,
 * framing 0.002) against CONSECUTIVE frames about half a second apart. Sampling
 * every 150 ms would shrink the motion between frames, drag the measured score
 * down and make the server refuse honest punches. So the floor is
 * `FACE_MIN_FRAMES × 500 ms` plus the detector and one round trip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT SAYS ABOUT ITSELF
 * ─────────────────────────────────────────────────────────────────────────────
 * The card states, on screen, that the check confirms a match against the
 * enrolled template and that the movement test is a heuristic against a
 * photograph rather than a certified liveness test. A location refusal is a
 * supported outcome, never a blocker: the punch is recorded without coordinates
 * and the screen says it will be marked for review. The direction is never a
 * client guess — the button's label comes from the employee's own punch log and
 * the confirmation shows the direction THE SERVER decided.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PunchLocation } from "@/shared/ui/PunchLocation";
import { Link } from "react-router-dom";
import { CheckCircle2, Loader2, MapPin, ScanFace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtCivilDate, fmtTime, istToday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { newIdempotencyKey } from "@/shared/api/invoke";
import {
  DESCRIPTOR_INPUT_SIZE,
  loadFaceModels,
  readFrame,
  type FrameVerdict,
} from "@/features/kiosk/lib/facePipeline";
import { AuthNotice } from "@/features/auth/components/AuthNotice";
import { browserCanUseCamera } from "@/features/auth/lib/cameraSupport";
import { browserDeviceId } from "@/features/auth/lib/browserDevice";
import {
  bestFrameIndex,
  checkConsistency,
  FACE_MAX_SCORED_FRAMES,
  FACE_MIN_FRAMES,
  isUsableDescriptor,
} from "@/features/auth/lib/faceConsistency";
import { measureLiveness } from "@/features/auth/lib/liveness";
import type { SignInGeo, SignInLocationStatus } from "@/features/auth/lib/geolocation";
// The module is named for the screen that first needed it; what it holds is the
// browser's one-shot geolocation outcome, which is exactly what a punch needs.
// There is a single geolocation implementation in this app and this is it.
import { useSignInLocation } from "@/features/auth/hooks/useSignInLocation";
import type { PunchRecorded, SelfPunchOutcome, SelfPunchState } from "../api/selfPunch.api";
import { useSelfPunch, useSelfPunchEligibility, useSelfPunchState } from "../hooks/useSelfPunch";

/**
 * Frame cadence. See the header: this is the spacing `liveness.ts` is calibrated
 * for, not an arbitrary throttle.
 */
const LOOP_MS = 500;

type Phase =
  | { name: "idle" }
  | { name: "location" }
  | { name: "engine" }
  | { name: "camera" }
  | { name: "capturing" }
  | { name: "sending" }
  | { name: "recorded"; outcome: PunchRecorded; elapsedMs: number }
  /** Settled, but nothing new was written — a replay, or an unreadable answer. */
  | { name: "noted"; message: string }
  | { name: "failed"; message: string };

/** One accepted reading, reduced to what the gate and the motion signal read. */
interface Reading {
  descriptor: number[];
  score: number;
  yaw: number;
  pitch: number;
  roll: number;
  box: { x: number; y: number; w: number; h: number };
}

/** Yield for `ms`, without blocking paint. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Pipeline verdict → what the user should do about it. The five generic
 * sentences are the sign-in catalogue's, rendered verbatim so the words do not
 * fork; only "more than one face" is re-worded, because that one names sign-in.
 */
function guidanceFor(verdict: FrameVerdict): string | null {
  switch (verdict.kind) {
    case "no_face":
      return t("auth.login.face.looking");
    case "many_faces":
      return t("me.punch.face.oneFace");
    case "poor":
      switch (verdict.reason) {
        case "too_small":
          return t("auth.login.face.stepCloser");
        case "too_dark":
          return t("auth.login.face.tooDark");
        case "too_blurry":
          return t("auth.login.face.holdStill");
        case "low_score":
          return t("auth.login.face.faceCamera");
      }
      break;
    case "ok":
      return null;
  }
  return null;
}

/** The location line, after the ask has settled. `null` = nothing to say yet. */
function locationLine(status: SignInLocationStatus, geo: SignInGeo | null): string | null {
  switch (status) {
    case "idle":
      return null;
    case "asking":
      return t("me.punch.location.asking");
    case "granted":
      return t("me.punch.location.granted", { metres: geo?.accuracy_m ?? 0 });
    case "denied":
      return t("me.punch.location.denied");
    case "unavailable":
      return t("me.punch.location.unavailable");
    case "error":
      return t("me.punch.location.error");
  }
}

/**
 * "Last scan 09:14 · 1 recorded today." — or, when the open punches are filed
 * under yesterday because the shift started before midnight, the date instead of
 * the word "today", which would be false for a night shift.
 */
function lastScanLine(state: SelfPunchState, today: string): string {
  if (state.lastPunchAt === null) return t("me.punch.state.noneToday");
  const time = fmtTime(state.lastPunchAt);
  if (state.businessDate !== null && state.businessDate !== today) {
    return t("me.punch.state.lastScanCarried", {
      time,
      count: state.punchCount,
      date: fmtCivilDate(state.businessDate),
    });
  }
  return t("me.punch.state.lastScan", { time, count: state.punchCount });
}

/** What was recorded, in the server's words where it wrote any. */
function recordedHeadline(outcome: PunchRecorded): string {
  const time = outcome.istTime;
  if (time === null || time.trim() === "") return t("me.punch.done.noTime");
  switch (outcome.direction) {
    case "in":
      return t("me.punch.done.in", { time });
    case "out":
      return t("me.punch.done.out", { time });
    case "unknown":
      return t("me.punch.done.scan", { time });
  }
}

/**
 * The location line under a recorded punch.
 *
 * THIS REPLACED A GEOFENCE VERDICT. The old line said one of three things —
 * "inside the venue", "outside the venue", or "location not checked" — and the
 * third was what every punch actually got, because the venue has no coordinates
 * configured. So an employee finishing a punch read a sentence about a boundary
 * that was never evaluated, sitting one word away from a sentence that accuses
 * them of being somewhere they should not be.
 *
 * Now it names the place. When a fix was attached, `PunchLocation` renders the
 * address, the coordinate and the accuracy — the same block the admin log shows,
 * so the employee sees exactly what was recorded about them. When no fix was
 * attached, that is still worth one sentence, because "no location was stored"
 * is a fact an employee may need later.
 */
function LocationLine({ outcome }: { outcome: PunchRecorded }) {
  if (!outcome.locationAttached || outcome.fix === null) {
    return (
      <p className="text-muted-foreground">{t("me.punch.location.dropped")}</p>
    );
  }
  return (
    <PunchLocation
      row={{
        lat: outcome.fix.latitude,
        lng: outcome.fix.longitude,
        location_accuracy_m: outcome.fix.accuracyMetres,
      }}
      variant="detail"
      className="text-left"
    />
  );
}

/**
 * The review sentence, and only on the SERVER's say-so. `needsReview` covers
 * reasons the browser cannot see — the venue network, a missing liveness
 * attestation, an employment status under review — so it is reported, not
 * deduced.
 *
 * IT NO LONGER SUPPRESSES ITSELF WHEN `geofenceOk === false`. That suppression
 * existed because `me.punch.done.outsideFence` said the same thing one line
 * above, and repeating it read badly. That sentence is gone — the location line
 * now names the actual place instead of judging it — so the guard would have
 * silently swallowed the ONE case it was written to tidy: a punch that the server
 * flagged AND placed outside the fence would have told the employee nothing at
 * all about being under review.
 */
function reviewLine(outcome: PunchRecorded): string | null {
  return outcome.needsReview === true ? t("me.punch.done.review") : null;
}

export interface SelfPunchCardProps {
  /** Grid placement from the host page. */
  className?: string;
}

export function SelfPunchCard({ className }: SelfPunchCardProps) {
  const eligibility = useSelfPunchEligibility();
  const entitled = eligibility.data?.allow_web_punch === true;
  const punchState = useSelfPunchState(entitled);
  const { mutateAsync } = useSelfPunch();
  const location = useSignInLocation();
  const cameraOk = useMemo(() => browserCanUseCamera(), []);

  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [guidance, setGuidance] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [engineWarm, setEngineWarm] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Rolling window of accepted readings. Never rendered, so a ref not state. */
  const windowRef = useRef<Reading[]>([]);
  const scoredRef = useRef(0);
  /** Bumped per attempt; every async step checks it before touching the UI. */
  const attemptRef = useRef(0);
  const firstFrameAtRef = useRef<number | null>(null);
  const geoRef = useRef<SignInGeo | null>(null);
  const eventIdRef = useRef<string>("");

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /**
   * WARM THE ENGINE ON MOUNT. The chunk and the three weight files are fetched
   * while the employee is still reading the card, so the tap goes almost
   * straight to the camera. Entitlement-gated: an employee who cannot punch
   * from the web never downloads a face model.
   */
  useEffect(() => {
    if (!entitled || !cameraOk) return;
    let cancelled = false;
    void loadFaceModels().then(
      () => {
        if (!cancelled) setEngineWarm(true);
      },
      () => {
        // Not surfaced yet: it is only a failure if the employee taps and it
        // still cannot load, and `start()` reports it then.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entitled, cameraOk]);

  // The camera is a physical device: released on unmount, always. The descriptor
  // window goes with it — a face reading has no reason to outlive the ceremony.
  useEffect(
    () => () => {
      attemptRef.current += 1;
      stopCamera();
      windowRef.current = [];
    },
    [stopCamera],
  );

  /** Send the agreeing window's best frame and settle the card. */
  const send = useCallback(
    async (token: number, readings: readonly Reading[]) => {
      const best = readings[bestFrameIndex(readings.map((r) => r.score))];
      if (best === undefined || !isUsableDescriptor(best.descriptor)) {
        stopCamera();
        setPhase({ name: "failed", message: t("me.punch.error.unusable") });
        return;
      }

      setPhase({ name: "sending" });
      // The decision is made: a live camera during a network wait is a camera
      // nobody is watching.
      stopCamera();

      // MEASURED, never asserted. `measureLiveness` returns 0 when it cannot
      // measure, and the server then refuses — which is the honest outcome for
      // "this device could not tell". It defeats a still image; it does not
      // defeat a photograph held in a hand, and the card says so.
      const liveness = measureLiveness(
        readings.map((reading) => ({
          descriptor: reading.descriptor,
          yaw: reading.yaw,
          pitch: reading.pitch,
          roll: reading.roll,
          box: reading.box,
        })),
      );

      const startedAt = firstFrameAtRef.current ?? performance.now();
      let outcome: SelfPunchOutcome;
      try {
        outcome = await mutateAsync({
          descriptor: best.descriptor,
          metrics: {
            detectionScore: best.score,
            // OMIT the score when the heuristic could not measure it.
            // `measureLiveness` returns 0 both for "no movement" and for "not
            // enough usable frames to tell", and the server reads those two very
            // differently: a PRESENT score below the threshold is positive spoof
            // evidence and is REFUSED, while an ABSENT score is recorded and
            // flagged `liveness_not_attested`. Sending 0 for "could not measure"
            // would therefore refuse an honest employee whose phone produced too
            // few frames — a harsher outcome than saying nothing at all. Only a
            // score we actually measured is asserted.
            ...(liveness.framesAnalysed >= 2 && liveness.score > 0
              ? {
                  livenessScore: liveness.score,
                  livenessModel: liveness.model,
                  framesAnalysed: liveness.framesAnalysed,
                }
              : {}),
          },
          geo: geoRef.current,
          deviceId: browserDeviceId(),
          clientEventId: eventIdRef.current,
        });
      } catch {
        // `selfPunch` resolves refusals, so anything thrown here is unexpected —
        // and the punch may still have landed, so the copy does not deny it.
        if (attemptRef.current !== token) return;
        setPhase({ name: "noted", message: t("me.punch.error.unreadable") });
        return;
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (attemptRef.current !== token) return;

      switch (outcome.kind) {
        case "recorded":
          setPhase({ name: "recorded", outcome, elapsedMs });
          return;
        case "already_recorded":
        case "unreadable":
          setPhase({ name: "noted", message: outcome.message });
          return;
        case "refused":
          setPhase({ name: "failed", message: outcome.message });
          return;
      }
    },
    [mutateAsync, stopCamera],
  );

  /**
   * The capture loop: one frame in flight, ever. `for(;;)` + `await` rather than
   * `setInterval`, so the next read cannot start before the current verdict.
   */
  const captureLoop = useCallback(
    async (token: number) => {
      for (;;) {
        if (attemptRef.current !== token) return;
        const video = videoRef.current;
        if (video === null) return;

        const frameStartedAt = performance.now();
        firstFrameAtRef.current ??= frameStartedAt;
        // `singlePass` halves the cost without touching the aligned crop, so the
        // descriptor is the same one the two-pass path returned. `inputSize` is
        // pinned to the shared constant because THIS is the frame that gets
        // compared against the template the admin's desk enrolled — the two sides
        // must be produced identically or every distance is meaningless.
        const verdict = await readFrame(video, {
          singlePass: true,
          inputSize: DESCRIPTOR_INPUT_SIZE,
        }).catch((): FrameVerdict => ({ kind: "no_face" }));
        if (attemptRef.current !== token) return;
        scoredRef.current += 1;

        if (verdict.kind !== "ok") {
          setGuidance(guidanceFor(verdict));
        } else {
          const next = [
            ...windowRef.current,
            {
              descriptor: verdict.reading.descriptor,
              score: verdict.reading.quality.detection_score,
              yaw: verdict.reading.quality.yaw,
              pitch: verdict.reading.quality.pitch,
              roll: verdict.reading.quality.roll,
              box: verdict.reading.box,
            },
          ].slice(-FACE_MIN_FRAMES);
          const agreement = checkConsistency(next.map((reading) => reading.descriptor));

          if (agreement.consistent) {
            windowRef.current = next;
            setFrameCount(next.length);
            setGuidance(null);
            await send(token, next);
            return;
          }

          if (next.length < FACE_MIN_FRAMES) {
            // Still filling the window — normal, no complaint to make.
            windowRef.current = next;
            setFrameCount(next.length);
            setGuidance(null);
          } else {
            // A full window that does not agree with itself: drop the oldest
            // reading and keep looking. Nothing was sent, and the user is told.
            windowRef.current = next.slice(1);
            setFrameCount(windowRef.current.length);
            setGuidance(t("auth.login.face.inconsistent"));
          }
        }

        if (scoredRef.current >= FACE_MAX_SCORED_FRAMES) {
          stopCamera();
          setPhase({
            name: "failed",
            message: t("me.punch.error.timedOut", { total: FACE_MIN_FRAMES }),
          });
          return;
        }

        const gap = LOOP_MS - (performance.now() - frameStartedAt);
        if (gap > 0) await sleep(gap);
      }
    },
    [send, stopCamera],
  );

  /** Location → engine → camera → frames. One tap runs the whole ceremony. */
  const start = useCallback(async () => {
    const token = attemptRef.current + 1;
    attemptRef.current = token;
    windowRef.current = [];
    scoredRef.current = 0;
    firstFrameAtRef.current = null;
    geoRef.current = null;
    // One key for the whole attempt: body `clientEventId` and the
    // `x-idempotency-key` header carry the same 36-character UUID, so a retry of
    // a punch the server already stored replays instead of doubling it.
    eventIdRef.current = newIdempotencyKey();
    setFrameCount(0);
    setGuidance(null);

    // 1. LOCATION FIRST, with the reason already on screen (it is in the idle
    //    body above this button). A refusal is not a failure: `ask()` resolves
    //    null and the ceremony continues to the camera.
    setPhase({ name: "location" });
    geoRef.current = await location.ask();
    if (attemptRef.current !== token) return;

    // 2. ENGINE. Normally already warm from the mount prefetch.
    setPhase({ name: "engine" });
    try {
      await loadFaceModels();
      setEngineWarm(true);
    } catch {
      setPhase({ name: "failed", message: t("me.punch.error.engine") });
      return;
    }
    if (attemptRef.current !== token) return;

    // 3. CAMERA.
    setPhase({ name: "camera" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 } },
        audio: false,
      });
      if (attemptRef.current !== token) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        await video.play();
      }
    } catch {
      stopCamera();
      setPhase({ name: "failed", message: t("me.punch.error.camera") });
      return;
    }
    if (attemptRef.current !== token) {
      stopCamera();
      return;
    }

    // 4. FRAMES.
    setPhase({ name: "capturing" });
    await captureLoop(token);
  }, [captureLoop, location, stopCamera]);

  const cancel = useCallback(() => {
    attemptRef.current += 1;
    stopCamera();
    windowRef.current = [];
    scoredRef.current = 0;
    setGuidance(null);
    setFrameCount(0);
    setPhase({ name: "idle" });
  }, [stopCamera]);

  const busy =
    phase.name === "location" ||
    phase.name === "engine" ||
    phase.name === "camera" ||
    phase.name === "capturing" ||
    phase.name === "sending";
  const cameraLive =
    phase.name === "camera" || phase.name === "capturing" || phase.name === "sending";
  const today = istToday();

  // ── The label. Direction from the employee's own punch log, never a guess:
  // while the read is in flight the button says so, and if the read failed it
  // does not invent a direction — it says "Punch attendance" and the server
  // decides, which is what the confirmation then reports.
  const next = punchState.data?.next ?? null;
  const buttonLabel = punchState.isPending
    ? t("me.punch.action.checking")
    : next === "out"
      ? t("me.punch.action.out")
      : next === "in"
        ? t("me.punch.action.in")
        : t("me.punch.action.scan");
  const buttonAria =
    next === "out"
      ? t("me.punch.action.outAria")
      : next === "in"
        ? t("me.punch.action.inAria")
        : t("me.punch.action.scanAria");

  const locationNote = locationLine(location.status, location.geo);

  let body: ReactNode;
  if (eligibility.isPending) {
    body = <Skeleton className="h-10 w-40" />;
  } else if (!cameraOk) {
    body = <AuthNotice tone="warning">{t("me.punch.error.noCamera")}</AuthNotice>;
  } else if (eligibility.data === null || !entitled) {
    // Told once, plainly, rather than leaving the employee to wonder where the
    // button is. `allow_web_punch` is HR's switch, and the copy names the way in.
    body = (
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("me.punch.unavailable.notEntitled")}
      </p>
    );
  } else if (phase.name === "recorded") {
    body = (
      <div className="space-y-3">
        {/* Tone follows the SERVER's flag first: a punch it marked for review is
            not a plain success, whatever the geofence said. */}
        <AuthNotice
          tone={
            phase.outcome.needsReview === true || phase.outcome.geofenceOk === false
              ? "warning"
              : "success"
          }
        >
          <p className="font-display text-base font-semibold">
            {recordedHeadline(phase.outcome)}
          </p>
          {phase.outcome.employeeName !== null ? (
            <p className="text-muted-foreground">
              {t("me.punch.done.who", { name: phase.outcome.employeeName })}
            </p>
          ) : null}
          <LocationLine outcome={phase.outcome} />
          {reviewLine(phase.outcome) !== null ? (
            <p className="text-muted-foreground">{reviewLine(phase.outcome)}</p>
          ) : null}
          {phase.outcome.message !== null ? (
            <p className="mt-1 text-muted-foreground">{phase.outcome.message}</p>
          ) : null}
          <p className="num mt-1 text-xs tabular-nums text-muted-foreground">
            {t("me.punch.done.elapsed", { seconds: (phase.elapsedMs / 1000).toFixed(1) })}
          </p>
        </AuthNotice>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={cancel}>
            {t("me.punch.action.done")}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/me/attendance/${today}`}>{t("me.punch.action.viewPunches")}</Link>
          </Button>
        </div>
      </div>
    );
  } else if (phase.name === "noted") {
    body = (
      <div className="space-y-3">
        <AuthNotice tone="info">{phase.message}</AuthNotice>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/me/attendance/${today}`}>{t("me.punch.action.viewPunches")}</Link>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel}>
            {t("me.punch.action.done")}
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {/* The reason is HERE, above the button, so it has been read before the
            browser's own permission dialog lands on top of it. */}
        {phase.name === "idle" ? (
          <AuthNotice tone="info" className="text-xs">
            <p className="font-medium">{t("me.punch.location.title")}</p>
            <p className="text-muted-foreground">{t("me.punch.location.reason")}</p>
          </AuthNotice>
        ) : null}

        {locationNote !== null && phase.name !== "idle" ? (
          <p
            className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {locationNote}
          </p>
        ) : null}

        {/* Viewfinder. Always mounted so the ref exists when the stream arrives;
            hidden until the camera is actually live. */}
        <div
          className={cn(
            "relative overflow-hidden rounded-lg border bg-neutral-950",
            cameraLive ? "aspect-[4/3]" : "hidden",
          )}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover"
          />
          <div
            className="absolute inset-x-0 bottom-0 bg-neutral-950/80 px-3 py-2 text-center text-sm text-neutral-100"
            aria-live="polite"
          >
            {phase.name === "sending"
              ? t("me.punch.step.sending")
              : phase.name === "camera"
                ? t("me.punch.step.camera")
                : (guidance ?? t("auth.login.face.looking"))}
          </div>
        </div>

        {phase.name === "capturing" ? (
          <p className="num text-xs tabular-nums text-muted-foreground" role="status">
            {t("me.punch.step.frames", { count: frameCount, total: FACE_MIN_FRAMES })}
          </p>
        ) : null}

        {phase.name === "failed" ? (
          <AuthNotice tone="error">
            <p className="font-medium">{t("me.punch.refusedTitle")}</p>
            <p className="text-muted-foreground">{phase.message}</p>
          </AuthNotice>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="lg"
            aria-label={buttonAria}
            // ALWAYS LIVE except during a capture already running (which has its
            // own Cancel next to it). It used to be disabled while
            // `punchState.isPending` — the direction lookup — so on first paint the
            // button was dead for as long as that query took, which reads as broken.
            // The label falls back to a neutral "Punch attendance" until the state
            // arrives, and the SERVER decides in-or-out regardless, so there is
            // nothing to wait for.
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            ) : (
              <ScanFace className="mr-2 size-4" aria-hidden />
            )}
            {phase.name === "failed" ? t("me.punch.action.again") : buttonLabel}
          </Button>
          {busy ? (
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              {t("me.punch.action.cancel")}
            </Button>
          ) : null}
          {phase.name === "idle" ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {engineWarm ? (
                <>
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                  {t("me.punch.step.ready")}
                </>
              ) : (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("me.punch.step.warming")}
                </>
              )}
            </span>
          ) : null}
        </div>

        {/* What is about to be recorded, and where the direction comes from. */}
        {phase.name === "idle" ? (
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            {punchState.isError ? (
              <p>{t("me.punch.state.unknownDirection")}</p>
            ) : next !== null ? (
              <p>{next === "out" ? t("me.punch.state.expectOut") : t("me.punch.state.expectIn")}</p>
            ) : null}
            {punchState.data !== undefined ? (
              <p className="num tabular-nums">{lastScanLine(punchState.data, today)}</p>
            ) : null}
            <p>{t("me.punch.state.direction")}</p>
            <p>{t("me.punch.face.frameRule", { total: FACE_MIN_FRAMES })}</p>
            {/* The disclosure, in words, every time — not once in a policy page. */}
            <p>{t("me.punch.face.honesty")}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className={cn("rounded-lg border bg-card", className)}
      aria-label={t("me.punch.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <ScanFace className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{t("me.punch.title")}</span>
        </h2>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/me/attendance/${today}`}>{t("me.punch.action.viewPunches")}</Link>
        </Button>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{t("me.punch.lead")}</p>
        {body}
      </div>
    </section>
  );
}
