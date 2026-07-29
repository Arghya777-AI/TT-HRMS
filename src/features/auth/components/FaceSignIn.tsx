/**
 * FaceSignIn — the browser half of face sign-in, shown as a visible ceremony.
 *
 * PIPELINE: `features/kiosk/lib/facePipeline.ts`, unchanged and unforked. There
 * is exactly ONE face pipeline in this app; it dynamic-imports
 * `@vladmandic/face-api` so the 1.3 MB `chunk-face` and its weights stay out of
 * the entry graph (architecture D-07), it gates frames on MIN_SCORE 0.6 /
 * MIN_FACE_PX 120 / MIN_BRIGHTNESS 0.18 / MIN_SHARPNESS 60, and it L2-normalises
 * the 128-D descriptor. The admin enrolment console imports it the same way.
 *
 * SEVERAL FRAMES, NOT ONE. A single frame is a photograph, and a photograph can
 * be held up to a camera. Nothing is sent until FACE_MIN_FRAMES consecutive good
 * readings agree with each other (see `lib/faceConsistency.ts` for what that
 * does and does not prove). The best-scoring frame of the agreeing window is the
 * one that goes on the wire — a real single-frame descriptor, exactly like the
 * kiosk sends, not an average no camera ever produced.
 *
 * EVERY STEP IS ON SCREEN: engine → camera → frames (n of 3) → server match, each
 * with its live state, plus the live guidance the pipeline's verdict implies
 * ("come closer", "too dark", "hold still"). A biometric ceremony that shows the
 * user nothing is one they cannot consent to.
 *
 * WEAKER, AND IT SAYS SO. The security notice is rendered before the camera is
 * ever started, and the fallback to password is available at every phase.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, ScanFace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  DESCRIPTOR_INPUT_SIZE,
  loadFaceModels,
  readFrame,
  type FrameVerdict,
} from "@/features/kiosk/lib/facePipeline";
import { signInWithFace, type SignedIn } from "../api/signin.api";
import {
  bestFrameIndex,
  checkConsistency,
  FACE_MAX_SCORED_FRAMES,
  FACE_MIN_FRAMES,
  isUsableDescriptor,
} from "../lib/faceConsistency";
import { measureLiveness } from "../lib/liveness";
import { refusalMessage } from "../lib/refusalCopy";
import { AuthNotice } from "./AuthNotice";

/** One scored frame every half second: fast enough to feel live, cheap enough for a phone. */
const LOOP_MS = 500;

type Phase =
  | { name: "intro" }
  | { name: "engine" }
  | { name: "camera" }
  | { name: "capturing" }
  | { name: "verifying" }
  | { name: "failed"; message: string };

interface Reading {
  descriptor: number[];
  score: number;
  /**
   * Pose and framing, kept so liveness can be MEASURED rather than asserted.
   * `readFrame` already computes all four (quality.yaw/pitch/roll from the 68
   * landmarks, plus the box) — this component used to drop them, which left
   * `measureLiveness` with nothing to work from.
   */
  yaw: number;
  pitch: number;
  roll: number;
  box: { x: number; y: number; w: number; h: number };
}

/** Pipeline verdict → what the user should do about it. */
function guidanceFor(verdict: FrameVerdict): string | null {
  switch (verdict.kind) {
    case "no_face":
      return t("auth.login.face.looking");
    case "many_faces":
      return t("auth.login.face.oneFace");
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

interface StepRowProps {
  label: string;
  state: string;
  status: "waiting" | "busy" | "done";
}

function StepRow({ label, state, status }: StepRowProps) {
  return (
    <li
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        status === "done" && "border-success/50 bg-success/5",
        status === "busy" && "border-primary/60 bg-primary/5 font-medium",
        status === "waiting" && "border-border text-muted-foreground",
      )}
    >
      <span className="flex items-center gap-2">
        {status === "done" ? (
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        ) : status === "busy" ? (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <span className="size-4 shrink-0 rounded-full border" aria-hidden />
        )}
        {label}
      </span>
      <span className="num text-xs tabular-nums text-muted-foreground">{state}</span>
    </li>
  );
}

export interface FaceSignInProps {
  /** `TT0042` or a work email — resolved server-side, never in the browser. */
  identifier: string;
  onSignedIn: (outcome: SignedIn) => void;
  onUsePassword: () => void;
  onCancel: () => void;
}

export function FaceSignIn({ identifier, onSignedIn, onUsePassword, onCancel }: FaceSignInProps) {
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const [guidance, setGuidance] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  /**
   * Per-attempt facts about what actually succeeded, so the step list keeps
   * telling the truth after a failure: "engine ✓, camera ✓, frames ✗" is a
   * different problem from "engine ✗", and the user can act on the difference.
   */
  const [engineReady, setEngineReady] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Rolling window of accepted readings; never rendered, so a ref not state. */
  const windowRef = useRef<Reading[]>([]);
  const scoredRef = useRef(0);
  const submittingRef = useRef(false);
  /**
   * One `readFrame` at a time. The detector takes 200–800 ms on a phone — longer
   * than LOOP_MS — so without this the interval starts a second read over the
   * same video element before the first has answered: two reads compete for the
   * CPU, both push into the window, and `scoredRef` stops matching the number of
   * frames actually judged (the count the server is told about).
   */
  const readingRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // The camera is a physical device: it is released on unmount, always. The
  // descriptor window goes with it — a face reading has no reason to outlive the
  // ceremony that took it.
  useEffect(
    () => () => {
      stopCamera();
      windowRef.current = [];
    },
    [stopCamera],
  );


  const reset = useCallback(() => {
    windowRef.current = [];
    scoredRef.current = 0;
    submittingRef.current = false;
    readingRef.current = false;
    setFrameCount(0);
    setGuidance(null);
    setEngineReady(false);
    setCameraStarted(false);
  }, []);

  const start = useCallback(async () => {
    reset();
    setPhase({ name: "engine" });
    try {
      await loadFaceModels();
    } catch {
      setPhase({ name: "failed", message: t("auth.login.face.engineFailed") });
      return;
    }
    setEngineReady(true);
    setPhase({ name: "camera" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        await video.play();
      }
    } catch {
      stopCamera();
      setPhase({ name: "failed", message: t("auth.login.face.cameraDenied") });
      return;
    }
    setCameraStarted(true);
    setPhase({ name: "capturing" });
  }, [reset, stopCamera]);

  /*
    ── THE CAMERA OPENS ITSELF ────────────────────────────────────────────────────

    There was a "Start the camera" button, and it was a click that could only ever be
    answered one way: somebody who has chosen face sign-in and is looking at a black
    rectangle wants the camera on. The button asked them to confirm the thing they had
    just asked for, and in the meantime the panel showed a dead preview above four rows
    reading "Waiting", which looks like a broken screen rather than a ready one.

    `startedRef` rather than a dependency on `phase`: this must fire exactly once for the
    life of the panel. Keying it on the phase would restart the camera after a failure,
    fighting the retry button and re-prompting for permission on a loop.

    The permission prompt is unaffected — `getUserMedia` still raises it, and it is still
    the browser's decision. What is gone is the click BEFORE the prompt, not the prompt.
  */
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  /** Send the agreeing window's best frame, then hand the session to the parent. */
  const submit = useCallback(
    async (readings: readonly Reading[]) => {
      const best = readings[bestFrameIndex(readings.map((r) => r.score))];
      if (best === undefined || !isUsableDescriptor(best.descriptor)) {
        stopCamera();
        setPhase({ name: "failed", message: t("auth.login.face.unusable") });
        return;
      }
      setPhase({ name: "verifying" });
      // The camera stops BEFORE the round trip: the decision is made, and a live
      // camera during a network wait is a camera nobody is watching.
      stopCamera();

      // `face-login` gates on BOTH scores and records them in
      // secure.face_match_log as forensic evidence, so neither may be invented.
      // `measureLiveness` reports 0 when it cannot measure — the server then
      // refuses, which is the honest outcome. It is a motion heuristic: it defeats
      // a half-detected passer-by and a hand-off, NOT a held photograph.
      const liveness = measureLiveness(
        readings.map((reading) => ({
          descriptor: reading.descriptor,
          yaw: reading.yaw,
          pitch: reading.pitch,
          roll: reading.roll,
          box: reading.box,
        })),
      );

      // No `geo` and no `framesScored`: the verify body is zod `.strict()`, so an
      // extra key is a 422. The location is not lost — `face-login` writes its own
      // sessions_audit row server-side (see signin.api.ts's header).
      const outcome = await signInWithFace({
        identifier,
        descriptor: best.descriptor,
        metrics: {
          detectionScore: best.score,
          livenessScore: liveness.score,
          livenessModel: liveness.model,
          framesAnalysed: liveness.framesAnalysed,
        },
      });
      if (outcome.kind === "signed_in") {
        onSignedIn(outcome);
        return;
      }
      setPhase({ name: "failed", message: refusalMessage(outcome, "face") });
    },
    [identifier, onSignedIn, stopCamera],
  );

  // The capture loop. One interval, one frame at a time, no overlap.
  useEffect(() => {
    if (phase.name !== "capturing") return;
    const id = window.setInterval(() => {
      void (async () => {
        const video = videoRef.current;
        if (video === null || submittingRef.current || readingRef.current) return;
        readingRef.current = true;
        try {
          // Same contract as every other descriptor path: `singlePass` for speed
          // (identical crop, one detector run), `DESCRIPTOR_INPUT_SIZE` so this
          // descriptor is comparable with the enrolled template.
          const verdict = await readFrame(video, {
            singlePass: true,
            inputSize: DESCRIPTOR_INPUT_SIZE,
          }).catch((): FrameVerdict => ({ kind: "no_face" }));
          if (submittingRef.current) return;
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
              submittingRef.current = true;
              await submit(next);
              return;
            }

            if (next.length < FACE_MIN_FRAMES) {
              // Still filling the window — normal, no complaint to make.
              windowRef.current = next;
              setFrameCount(next.length);
              setGuidance(null);
            } else {
              // A full window that does NOT agree with itself: drop the oldest
              // reading and keep looking. Nothing was sent, and the user is told why.
              windowRef.current = next.slice(1);
              setFrameCount(windowRef.current.length);
              setGuidance(t("auth.login.face.inconsistent"));
            }
          }

          if (!submittingRef.current && scoredRef.current >= FACE_MAX_SCORED_FRAMES) {
            submittingRef.current = true;
            stopCamera();
            setPhase({
              name: "failed",
              message: t("auth.login.face.timedOut", { total: FACE_MIN_FRAMES }),
            });
          }
        } finally {
          readingRef.current = false;
        }
      })();
    }, LOOP_MS);
    return () => window.clearInterval(id);
  }, [phase.name, stopCamera, submit]);

  const cameraLive = phase.name === "capturing" || phase.name === "verifying";
  const framesDone = phase.name === "verifying";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
          <ScanFace className="size-4" aria-hidden />
          {t("auth.login.face.title")}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("auth.login.face.frameRule", { total: FACE_MIN_FRAMES })}
        </p>
      </div>

      <AuthNotice tone="warning">{t("auth.login.face.security")}</AuthNotice>

      {/* Viewfinder — mirrored, because people expect a mirror. */}
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg border bg-neutral-950">
        <video
          ref={videoRef}
          muted
          playsInline
          className={cn(
            "h-full w-full -scale-x-100 object-cover",
            cameraLive ? "opacity-100" : "opacity-25",
          )}
        />
        <div
          className="absolute inset-x-0 bottom-0 bg-neutral-950/80 px-3 py-2 text-center text-sm text-neutral-100"
          aria-live="polite"
        >
          {phase.name === "intro"
            ? t("auth.login.face.hint")
            : phase.name === "engine"
              ? t("auth.login.face.state.engine")
              : phase.name === "camera"
                ? t("auth.login.face.state.cameraAsking")
                : phase.name === "verifying"
                  ? t("auth.login.face.verifying")
                  : phase.name === "failed"
                    ? phase.message
                    : (guidance ?? t("auth.login.face.looking"))}
        </div>
      </div>

      <ol className="space-y-1.5">
        <StepRow
          label={t("auth.login.face.step.engine")}
          status={engineReady ? "done" : phase.name === "engine" ? "busy" : "waiting"}
          state={
            engineReady
              ? t("auth.login.face.state.engineReady")
              : phase.name === "engine"
                ? t("auth.login.face.state.engine")
                : t("auth.login.face.state.waiting")
          }
        />
        <StepRow
          label={t("auth.login.face.step.camera")}
          status={cameraStarted ? "done" : phase.name === "camera" ? "busy" : "waiting"}
          state={
            cameraStarted
              ? t("auth.login.face.state.cameraOn")
              : phase.name === "camera"
                ? t("auth.login.face.state.cameraAsking")
                : t("auth.login.face.state.waiting")
          }
        />
        <StepRow
          label={t("auth.login.face.step.frames")}
          status={framesDone ? "done" : phase.name === "capturing" ? "busy" : "waiting"}
          state={t("auth.login.face.state.frames", { count: frameCount, total: FACE_MIN_FRAMES })}
        />
        <StepRow
          label={t("auth.login.face.step.verify")}
          status={phase.name === "verifying" ? "busy" : "waiting"}
          state={
            phase.name === "verifying"
              ? t("auth.login.face.state.verifying")
              : t("auth.login.face.state.waiting")
          }
        />
      </ol>

      {phase.name === "failed" ? (
        <AuthNotice tone="error">
          <p className="font-medium">{t("auth.login.face.refusedTitle")}</p>
          <p className="text-muted-foreground">{phase.message}</p>
        </AuthNotice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {/*
          No "Start the camera" button: the effect above opens it on mount. The RETRY button
          below stays, because after a failure a click IS a real decision — the reader has
          read why it failed and is choosing to go again.
        */}
        {phase.name === "failed" ? (
          <Button type="button" onClick={() => void start()}>
            {t("auth.login.face.retry")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onUsePassword}>
          {t("auth.login.face.usePassword")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("auth.login.face.cancel")}
        </Button>
      </div>
    </section>
  );
}
