/**
 * useCamera — one live camera, one honest state machine.
 *
 * The client asked for "an option like Front and Back Camera", on a phone. Three
 * things make that harder than it sounds, and each one is handled here rather
 * than in the screen:
 *
 *   1. A switch has to be able to FAIL LOUDLY. Asking for `facingMode:
 *      {ideal:'environment'}` on a laptop quietly returns the front camera, so the
 *      guard would think they had switched. An explicit tap therefore asks with
 *      `exact`; when the browser refuses, this hook reverts to the working side
 *      and raises a notice the screen shows verbatim.
 *   2. TWO STREAMS AT ONCE BREAKS THE SECOND. Every open stops the previous
 *      tracks first, in the effect's own cleanup, so a fast double-tap cannot
 *      leave the phone holding two.
 *   3. THE PROMPT AND ITS REFUSAL ARE PART OF THE UI. `status: "failed"` carries
 *      the reason so the screen can say "allow the camera and reload" instead of
 *      spinning forever.
 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import {
  loadFacingChoice,
  openCamera,
  saveFacingChoice,
  stopStream,
  type CameraFailure,
  type Facing,
} from "../lib/camera";

/** Raised when the requested side does not exist on this device. */
export type CameraNotice = "no_back" | "no_front";

export interface CameraState {
  status: "starting" | "live" | "failed";
  /** Set only when `status === "failed"`. */
  failure: CameraFailure | null;
  /** The side currently in use (or being opened). */
  facing: Facing;
  /** What the track says it is, when it says anything. */
  reported: Facing | null;
  /** Video inputs the browser admits to once permission exists. 0 until then. */
  cameraCount: number;
  /** True while an already-live camera is being swapped, so the UI can say so. */
  switching: boolean;
  notice: CameraNotice | null;
}

interface OpenRequest {
  facing: Facing;
  /** `exact` rather than `ideal` — used for a deliberate tap, not the first open. */
  strict: boolean;
  /** Bumped to force a retry of an identical request. */
  attempt: number;
}

const other = (facing: Facing): Facing => (facing === "user" ? "environment" : "user");

export interface UseCameraResult {
  state: CameraState;
  /** Only ever meaningful when more than one camera exists. */
  chooseFacing: (facing: Facing) => void;
  retry: () => void;
  /** True when a front/back toggle is worth showing at all. */
  canSwitch: boolean;
}

export interface UseCameraOptions {
  /** Which side to open first. */
  initial: Facing;
  /**
   * Whether this screen participates in the session-wide choice.
   *
   * The scan loop does (`true`): a guard who picked the back camera for the queue
   * keeps it across a reload. Guard sign-in does NOT: the client's instruction is
   * "the security guy scans his face first with the front camera", so that screen
   * always opens the front camera even if the queue was last scanned with the
   * back one. A tap there still switches — it just is not remembered.
   */
  remember?: boolean;
}

export function useCamera(
  videoRef: RefObject<HTMLVideoElement>,
  options: UseCameraOptions,
): UseCameraResult {
  const { initial, remember = true } = options;
  const initialFacing = useMemo<Facing>(
    () => (remember ? loadFacingChoice() ?? initial : initial),
    [initial, remember],
  );
  const [request, setRequest] = useState<OpenRequest>({
    facing: initialFacing,
    strict: false,
    attempt: 0,
  });
  const [state, setState] = useState<CameraState>({
    status: "starting",
    failure: null,
    facing: initialFacing,
    reported: null,
    cameraCount: 0,
    switching: false,
    notice: null,
  });

  useEffect(() => {
    let cancelled = false;
    let opened: MediaStream | null = null;

    setState((prev) => ({
      ...prev,
      status: "starting",
      failure: null,
      switching: prev.status === "live",
      facing: request.facing,
    }));

    void (async () => {
      const result = await openCamera(request.facing, request.strict);
      if (cancelled) {
        if (result.ok) stopStream(result.stream);
        return;
      }

      if (!result.ok) {
        // A deliberate switch to a side this device does not have: go back to the
        // side that works and SAY so. Anything else is a real failure.
        if (request.strict && result.failure === "no_camera") {
          setState((prev) => ({
            ...prev,
            notice: request.facing === "environment" ? "no_back" : "no_front",
          }));
          setRequest((prev) => ({ facing: other(prev.facing), strict: false, attempt: prev.attempt + 1 }));
          return;
        }
        setState((prev) => ({
          ...prev,
          status: "failed",
          failure: result.failure,
          switching: false,
        }));
        return;
      }

      opened = result.stream;
      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = result.stream;
        try {
          await video.play();
        } catch {
          // Autoplay refusal on a muted inline video is rare; the frame loop
          // tolerates a paused element (it reads readyState) and the user tapping
          // anywhere starts it.
        }
      }
      if (cancelled) {
        stopStream(result.stream);
        return;
      }
      setState({
        status: "live",
        failure: null,
        facing: result.requested,
        reported: result.reported,
        cameraCount: result.cameraCount,
        switching: false,
        notice: null,
      });
    })();

    return () => {
      cancelled = true;
      stopStream(opened);
    };
  }, [request, videoRef]);

  const chooseFacing = useCallback(
    (facing: Facing) => {
      if (remember) saveFacingChoice(facing);
      setRequest((prev) =>
        prev.facing === facing && prev.strict
          ? prev
          : { facing, strict: true, attempt: prev.attempt + 1 },
      );
    },
    [remember],
  );

  const retry = useCallback(() => {
    setState((prev) => ({ ...prev, notice: null }));
    setRequest((prev) => ({ ...prev, strict: false, attempt: prev.attempt + 1 }));
  }, []);

  return {
    state,
    chooseFacing,
    retry,
    // Before permission exists the count is 0 and a toggle would be a guess, so
    // it stays hidden until the browser has told us there really are two.
    canSwitch: state.cameraCount > 1,
  };
}
