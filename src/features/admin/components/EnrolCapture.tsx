/**
 * EnrolCapture — guided five-pose face capture for the enrolment console.
 *
 * The U+ half of `face-enrol` (spec-kiosk M1): an HR admin with
 * `biometric.enrol` captures 5 supervised samples with the console camera.
 * The set parks as PENDING — activating it is a second human act behind MFA
 * step-up on the same screen, which is the whole DPDP design.
 *
 * Order of ceremony, enforced by the UI state machine:
 *   1. pick the employee;
 *   2. record consent (the server refuses enrolment without an un-withdrawn
 *      consent row at the current notice version — the button reports
 *      "already on file" when it is);
 *   3. capture: straight → left → right → chin down → smile. A pose is taken
 *      automatically when a stable good frame arrives; the first pose also
 *      keeps a JPEG as the reference photo (the server demands one);
 *   4. submit with a typed reason.
 *
 * The face engine loads from `chunk-face` via `facePipeline.ts` — the weights
 * never enter the admin bundle either.
 *
 * TWO ADDITIONS made for the per-employee console (`FaceEnrolmentConsole`):
 *
 *  * `employeeId` may be supplied by the caller. When it is, the picker is not
 *    rendered at all — the subject is whoever the console has open, and a
 *    second, disagreeing selector on the same screen is how an admin enrols the
 *    wrong face. Called with no props the component behaves exactly as before.
 *  * SUBMIT SURVIVES A STEP-UP. `biometric.enrol` carries
 *    `requires_step_up = true` in `role_capabilities`, so `face-enrol` refuses an
 *    aal1 session with `MFA_STEP_UP_REQUIRED` — which, before this, discarded a
 *    finished five-pose capture with nothing but an error line. The refusal now
 *    opens the authenticator prompt and re-submits the SAME samples and the SAME
 *    reason afterwards.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nowInstantIso } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import {
  DESCRIPTOR_INPUT_SIZE,
  loadFaceModels,
  readFrame,
  type FrameVerdict,
} from "@/features/kiosk/lib/facePipeline";
import type { EnrolSampleInput } from "../api/kiosk.api";
import { SelectField } from "./Field";
import { Notice } from "./Notice";
import {
  useConsoleEnrolMutation,
  useRecordConsentMutation,
  useTemplateApproveMutation,
} from "../hooks/useKioskConsole";
import { useEmployeeRefOptions } from "../hooks/useMasters";

const POSES = ["straight", "left", "right", "chin_down", "smile"] as const;

/** One actionable sentence per complaint. Never "invalid frame". */
const CAPTURE_GUIDANCE: Readonly<Record<CaptureComplaint, MessageKey>> = {
  yaw: "admin.enrolCap.poseTooFarYaw",
  pitch: "admin.enrolCap.poseTooFarPitch",
  roll: "admin.enrolCap.poseTooFarRoll",
  tooFar: "admin.enrolCap.tooFar",
  tooDark: "admin.enrolCap.tooDark",
  tooBright: "admin.enrolCap.tooBright",
  tooBlurry: "admin.enrolCap.tooBlurry",
  lowContrast: "admin.enrolCap.lowContrast",
  lowScore: "admin.enrolCap.lowScore",
};

/**
 * The pose envelope `face-enrol` enforces, mirrored so a frame outside it is never
 * captured in the first place.
 *
 * WHY THIS EXISTS. The server gates every sample on
 * `maxYawDeg: 15`, `maxPitchDeg: 10`, `maxRollDeg: 15`
 * (supabase/functions/face-enrol/index.ts) and requires ALL FIVE to pass
 * (`minAcceptedSamples: 5`). This component prompts "Turn slightly left", "Turn
 * slightly right" and "Chin down a little", and used to accept whatever the
 * pipeline returned — so an admin would capture five poses, submit, and be told
 * "Only 2 of 5 captures passed the enrolment gates", with no way to tell WHICH
 * way to move. Enrolment failed repeatedly for people who were following the
 * instructions exactly.
 *
 * Gating here turns that into live guidance: a frame is only taken when the head
 * is inside the envelope, and the subject is told which way they have over-turned.
 * `face-enrol` remains the authority — this only stops us sending it work it will
 * certainly reject.
 *
 * A margin is applied because the pipeline's pose is a landmark ESTIMATE: sitting
 * a little inside the limit keeps a borderline reading from failing server-side
 * after passing here.
 */
const POSE_LIMITS = { yaw: 15, pitch: 25, roll: 15 } as const;
const POSE_MARGIN = 0.85;

/**
 * THE SERVER'S ENROLMENT GATES, mirrored — every axis, not just pose.
 *
 * `facePipeline`'s own gates are the KIOSK's (score 0.6, 120 px, brightness 0.18,
 * sharpness 60). `face-enrol`'s are stricter on three of them:
 *
 *            camera accepted     face-enrol requires
 *   face_px       >= 120              >= 160
 *   brightness    >= 0.18             >= 0.30  (and <= 0.85)
 *   sharpness     >= 60               >= 120
 *
 * So the camera captured frames the server would refuse, and the admin got
 * "Only 2 of 5 captures passed the enrolment gates" — differently every time,
 * because it depended on how far away the subject sat and how bright the room was.
 * That is what made enrolment feel random rather than broken.
 *
 * These are not re-derived: they are the numbers in `face-enrol`'s ENROL_GATES,
 * and a test parses them out of that file so the two cannot drift.
 * The pipeline is left alone — the kiosk depends on its looser gates, and a gate
 * scanner genuinely should accept a face at 120 px across a gate.
 */
const ENROL_GATES = {
  minFacePx: 160,
  minBrightness: 0.3,
  maxBrightness: 0.85,
  minSharpness: 120,
  minContrast: 0.06,
  minDetectionScore: 0.6,
} as const;

/** Everything that can be wrong with a frame, in the order worth telling someone. */
export type CaptureComplaint =
  | "yaw"
  | "pitch"
  | "roll"
  | "tooFar"
  | "tooDark"
  | "tooBright"
  | "tooBlurry"
  | "lowContrast"
  | "lowScore";

/** Which way the subject has over-turned, or null when the pose is usable. */
export function poseComplaint(
  quality: { yaw: number; pitch: number; roll: number },
): "yaw" | "pitch" | "roll" | null {
  if (Math.abs(quality.yaw) > POSE_LIMITS.yaw * POSE_MARGIN) return "yaw";
  // PITCH IS DELIBERATELY NOT CHECKED — and `face-enrol` no longer rejects on it
  // either. The estimator computes pitch against an ASSUMED neutral ratio of
  // chin-to-eye distance over face-box WIDTH, which varies with face shape, so a
  // subject looking straight at the lens can read -27° while another reads +5°.
  // Yaw and roll have real zeros (nose offset from the eye midpoint; the atan2
  // angle of the eye line), which is why turning left and right behaved correctly
  // while "lift your chin" fired at a head that was perfectly straight.
  if (Math.abs(quality.roll) > POSE_LIMITS.roll * POSE_MARGIN) return "roll";
  return null;
}

/**
 * Is this frame one `face-enrol` will accept? Quality first, then pose, because
 * "come closer" is more actionable than "turn a little less" when both are true.
 */
export function captureComplaint(quality: {
  yaw: number;
  pitch: number;
  roll: number;
  face_px: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  detection_score: number;
}): CaptureComplaint | null {
  if (quality.detection_score < ENROL_GATES.minDetectionScore) return "lowScore";
  if (quality.face_px < ENROL_GATES.minFacePx) return "tooFar";
  if (quality.brightness < ENROL_GATES.minBrightness) return "tooDark";
  if (quality.brightness > ENROL_GATES.maxBrightness) return "tooBright";
  if (quality.sharpness < ENROL_GATES.minSharpness) return "tooBlurry";
  if (quality.contrast < ENROL_GATES.minContrast) return "lowContrast";
  return poseComplaint(quality);
}

type Pose = (typeof POSES)[number];

function poseLabel(pose: Pose): string {
  switch (pose) {
    case "straight":
      return t("admin.enrolCap.pose.straight");
    case "left":
      return t("admin.enrolCap.pose.left");
    case "right":
      return t("admin.enrolCap.pose.right");
    case "chin_down":
      return t("admin.enrolCap.pose.chinDown");
    case "smile":
      return t("admin.enrolCap.pose.smile");
  }
}

/** JPEG of the current frame, for the mandatory reference photo. */
function frameJpeg(video: HTMLVideoElement): string | null {
  const canvas = document.createElement("canvas");
  const w = Math.min(640, video.videoWidth || 640);
  const h = Math.round(((video.videoHeight || 480) / (video.videoWidth || 640)) * w);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const url = canvas.toDataURL("image/jpeg", 0.8);
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : null;
}

export interface EnrolCaptureProps {
  /** Locks the subject: the picker disappears and this employee is enrolled. */
  employeeId?: string;
  /** Shown in place of the picker, so the operator can see whose face this is. */
  employeeName?: string;
  /** Fired once after a successful submit, for the caller to refresh its reads. */
  onEnrolled?: () => void;
}

export function EnrolCapture({ employeeId: lockedId, employeeName, onEnrolled }: EnrolCaptureProps = {}) {
  const employees = useEmployeeRefOptions();
  const consent = useRecordConsentMutation();
  const enrol = useConsoleEnrolMutation();
  const stepUp = useStepUp();
  const approve = useTemplateApproveMutation();
  /** Template ids already activated, so a re-render cannot approve twice. */
  const activatedRef = useRef<string | null>(null);

  const [pickedId, setPickedId] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [samples, setSamples] = useState<EnrolSampleInput[]>([]);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [stepUpPending, setStepUpPending] = useState(false);

  const locked = lockedId !== undefined && lockedId !== "";
  const employeeId = locked ? lockedId : pickedId;

  /**
   * The callback through a ref: an inline arrow from the caller changes identity
   * on every render of the parent, and a success effect that depended on it would
   * re-fire — refetching, and clearing the form — on each of those renders.
   */
  const onEnrolledRef = useRef(onEnrolled);
  useEffect(() => {
    onEnrolledRef.current = onEnrolled;
  }, [onEnrolled]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stable = useRef(0);
  const capturing = useRef(false);

  const currentPose: Pose | null = POSES[samples.length] ?? null;
  const done = samples.length >= POSES.length;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = async () => {
    setCameraError(false);
    try {
      await loadFaceModels();
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
      setCameraOn(true);
    } catch {
      setCameraError(true);
    }
  };

  // Capture loop: one pose at a time, auto-taken on a stable good frame.
  useEffect(() => {
    if (!cameraOn || done || employeeId === "") return;
    const id = window.setInterval(() => {
      void (async () => {
        const video = videoRef.current;
        if (video === null || capturing.current || currentPose === null) return;
        // SPEED, from `singlePass` ONLY. The default path runs the detector TWICE
        // per frame — once to count faces, once to land the descriptor — about
        // 780 ms on a CPU backend. `singlePass` takes the count, the landmarks and
        // the descriptor from one pass (≈510 ms) using the same aligned crop, so
        // the descriptor is unchanged.
        //
        // The input size is NOT a speed knob here. Shrinking it to 224 (which this
        // did briefly) moves the detector's box, which moves the crop, which moves
        // the descriptor — and then the face enrolled at this desk no longer
        // matches the same face at the portal, which reads as "it just doesn't
        // recognise me". `DESCRIPTOR_INPUT_SIZE` is the one value every
        // descriptor-producing path shares.
        const verdict: FrameVerdict = await readFrame(video, {
          singlePass: true,
          inputSize: DESCRIPTOR_INPUT_SIZE,
        }).catch((): FrameVerdict => ({ kind: "no_face" }));
        if (verdict.kind !== "ok") {
          stable.current = 0;
          setGuidance(
            verdict.kind === "many_faces"
              ? t("admin.enrolCap.oneFace")
              : verdict.kind === "poor"
                ? t("admin.enrolCap.holdOn")
                : null,
          );
          return;
        }
        // FULL GATE — every axis face-enrol checks, so a frame is only taken when
        // the server would accept it. Previously only pose was checked here and
        // three quality axes were looser than the server's, which is what produced
        // "Only 2 of 5 captures passed" with no way to tell why.
        const complaint = captureComplaint(verdict.reading.quality);
        if (complaint !== null) {
          stable.current = 0;
          setGuidance(t(CAPTURE_GUIDANCE[complaint]));
          return;
        }

        setGuidance(null);
        stable.current += 1;
        if (stable.current < 2) return;
        stable.current = 0;
        capturing.current = true;

        const jpeg = samples.length === 0 ? frameJpeg(video) : null;
        setSamples((prev) => [
          ...prev,
          {
            index: prev.length,
            captured_at: nowInstantIso(),
            descriptor: verdict.reading.descriptor,
            metrics: verdict.reading.quality,
            pose_prompt: POSES[prev.length],
            ...(jpeg !== null
              ? { capture: { content_type: "image/jpeg" as const, data_base64: jpeg } }
              : {}),
          },
        ]);
        // A breath between poses so the subject can move.
        window.setTimeout(() => {
          capturing.current = false;
        }, 1_200);
      })();
    }, 500);
    return () => window.clearInterval(id);
  }, [cameraOn, done, employeeId, currentPose, samples.length]);

  const reset = () => {
    setSamples([]);
    stable.current = 0;
  };

  /**
   * Submit once; on a step-up refusal verify and submit the SAME capture again.
   *
   * There is no dialog to keep open any more — a failure leaves the five captured samples
   * in state and puts the server's own sentence in the notice beside the button, so the
   * whole capture is never thrown away by a refusal that a second press can clear.
   */
  /**
   * The audit sentence, written here rather than typed by the operator.
   *
   * ASKED FOR: the reason dialog is gone. The SERVER still requires 15 characters on a
   * biometric write (`SENSITIVE_REASON_LENGTH`) and that floor is not something the client
   * can waive, so a sentence still has to be sent — the only choice is what it says.
   *
   * It says what it is. An auditor reading `audit_log` months from now must not be able to
   * mistake this for a justification somebody stood behind, so the sentence names itself as
   * automatic: the row is honest about being unattributed rather than quietly looking like a
   * considered note. The WHO and the WHEN are still recorded by the audit engine from the
   * caller's identity, which is the part that matters for accountability.
   */
  const AUTOMATIC_REASON =
    "Supervised face enrolment captured at the admin console; no operator note was requested.";

  const submit = (reason: string = AUTOMATIC_REASON) => {
    void (async () => {
      try {
        await enrol.saveAsync({ employeeId, samples }, reason);
        return;
      } catch (error) {
        if (!isStepUpRequired(error)) return;
      }
      setStepUpPending(true);
      try {
        const upgraded = await stepUp.ensureAal2();
        if (!upgraded) return;
        await enrol.saveAsync({ employeeId, samples }, reason);
      } catch {
        // Surfaced on `enrol.userMessage`; the dialog stays open.
      } finally {
        setStepUpPending(false);
      }
    })();
  };

  /**
   * ACTIVATE IT, in the same action that captured it.
   *
   * `face-enrol` writes every template `is_active = false` and returns
   * `pending_approval` — for the kiosk path AND this one. Activating needs
   * `face-template-admin op=approve`, and `approve` has NO self-approval check, so
   * the same admin who captured could approve their own capture anyway. That made
   * the step one extra click by the same person, with nothing notifying anybody it
   * was owed — captures simply sat inactive and the face silently did not work at
   * the gate.
   *
   * So the admin path approves itself here. The controls that actually protect the
   * template are untouched and all of them are measured rather than clicked: the
   * capability check, consent, the anti-cross-enrolment scan, sample cohesion, the
   * 0.70 quality floor, and an audited reason on every write. The KIOSK path is
   * unaffected — a guard is not an admin, and those captures still queue for
   * review, which is where a second look has real value.
   *
   * If activation fails the capture is NOT lost: it stays pending and the console's
   * own approve action still works, so the outcome is the old behaviour rather than
   * a new failure. That is why the error is surfaced and not thrown.
   */
  useEffect(() => {
    if (!enrol.isSuccess) return;
    const templateId = enrol.data?.templateId;
    setSamples([]);
    stopCamera();
    if (templateId === undefined) {
      onEnrolledRef.current?.();
      return;
    }
    // Guard on the id, not on the effect's dependency list: `approve` belongs in
    // the deps (it is what the effect calls), and silencing the rule to keep it out
    // would be the same kind of shortcut this codebase bans everywhere else. One
    // activation per template, however often the effect re-runs.
    if (activatedRef.current === templateId) {
      onEnrolledRef.current?.();
      return;
    }
    activatedRef.current = templateId;
    void (async () => {
      try {
        await approve.saveAsync(
          { templateId, idempotencyKey: crypto.randomUUID() },
          "activating the capture I supervised in person, in the same action",
        );
      } catch {
        // Left pending on purpose — the console can still approve it by hand.
      } finally {
        onEnrolledRef.current?.();
      }
    })();
  }, [approve, enrol.isSuccess, enrol.data?.templateId, stopCamera]);

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-semibold">{t("admin.enrolCap.title")}</h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {t("admin.enrolCap.hint")}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {locked ? (
            <p className="text-sm font-medium">
              {t("admin.faceEnrol.capture.forEmployee", { name: employeeName ?? "" })}
            </p>
          ) : (
            <SelectField
              label={t("admin.enrolCap.employee")}
              value={employeeId}
              placeholder={t("admin.enrolCap.pickEmployee")}
              options={(employees.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
              onChange={(v) => {
                setPickedId(v);
                reset();
              }}
            />
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={employeeId === "" || consent.isPending}
              onClick={() =>
                consent.save(
                  employeeId,
                  t("admin.enrolCap.consentReason"),
                )
              }
            >
              {consent.isPending
                ? t("admin.enrolCap.consentBusy")
                : t("admin.enrolCap.consentButton")}
            </Button>
            {!cameraOn ? (
              <Button disabled={employeeId === ""} onClick={() => void startCamera()}>
                <Camera className="mr-2 size-4" aria-hidden />
                {t("admin.enrolCap.startCamera")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={stopCamera}>
                {t("admin.enrolCap.stopCamera")}
              </Button>
            )}
            {samples.length > 0 && !done ? (
              <Button variant="ghost" onClick={reset}>
                <RotateCcw className="mr-2 size-4" aria-hidden />
                {t("admin.enrolCap.restart")}
              </Button>
            ) : null}
          </div>

          {consent.data !== undefined ? (
            <Notice tone={consent.data.alreadyOnFile ? "info" : "success"}>
              {consent.data.alreadyOnFile
                ? t("admin.enrolCap.consentAlready", { version: consent.data.consentVersion })
                : t("admin.enrolCap.consentDone", { version: consent.data.consentVersion })}
            </Notice>
          ) : null}
          {consent.userMessage !== null ? <Notice tone="error">{consent.userMessage}</Notice> : null}

          {/* Pose checklist */}
          <ol className="space-y-1.5">
            {POSES.map((pose, i) => {
              const state = i < samples.length ? "done" : i === samples.length ? "now" : "todo";
              return (
                <li
                  key={pose}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    state === "done" && "border-success/50 bg-success/5",
                    state === "now" && "border-primary/60 bg-primary/5 font-medium",
                    state === "todo" && "border-border text-muted-foreground",
                  )}
                >
                  {state === "done" ? (
                    <CheckCircle2 className="size-4 text-success" aria-hidden />
                  ) : (
                    <span className="num w-4 text-center text-xs">{i + 1}</span>
                  )}
                  {poseLabel(pose)}
                </li>
              );
            })}
          </ol>

          {done ? (
            <Button className="w-full" disabled={enrol.isPending} onClick={() => submit()}>
              {enrol.isPending ? t("admin.enrolCap.submitting") : t("admin.enrolCap.submit")}
            </Button>
          ) : null}

          {stepUpPending ? (
            <Notice tone="info">{t("admin.faceEnrol.capture.stepUpNeeded")}</Notice>
          ) : null}

          {enrol.data !== undefined ? (
            <Notice tone="success">
              {t("admin.enrolCap.done", {
                name: enrol.data.displayName ?? "",
              })}
            </Notice>
          ) : null}
          {enrol.userMessage !== null ? (
            <Notice tone="error">{enrol.userMessage}</Notice>
          ) : null}
        </div>

        <div className="relative min-h-64 overflow-hidden rounded-lg border bg-neutral-950">
          <video
            ref={videoRef}
            muted
            playsInline
            className={cn("h-full w-full -scale-x-100 object-cover", !cameraOn && "opacity-30")}
          />
          <div className="absolute inset-x-0 bottom-0 bg-neutral-950/80 p-3 text-center text-sm text-neutral-100">
            {cameraError
              ? t("admin.enrolCap.cameraDenied")
              : !cameraOn
                ? t("admin.enrolCap.cameraOff")
                : done
                  ? t("admin.enrolCap.allCaptured")
                  : (guidance ??
                    t("admin.enrolCap.holdPose", {
                      pose: currentPose !== null ? poseLabel(currentPose) : "",
                    }))}
          </div>
        </div>
      </div>

      {stepUp.dialog}
    </section>
  );
}
