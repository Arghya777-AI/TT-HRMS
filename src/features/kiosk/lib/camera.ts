/**
 * camera.ts — the gate scanner's camera, for a phone held in one hand.
 *
 * The client's ask: "Opening the link on a device should allow using the front or
 * back camera (mostly on mobile). There should be an option like Front and Back
 * Camera." So this file owns three honest answers:
 *
 *   1. WHICH CAMERAS EXIST. `enumerateDevices()` only tells the truth AFTER a
 *      stream has been granted once — before that, browsers hide labels and some
 *      collapse the list to a single placeholder. So the count is taken after the
 *      first successful `getUserMedia`, and until then the UI shows no toggle
 *      rather than a toggle that might be dead.
 *   2. WHETHER THE SWITCH ACTUALLY SWITCHED. Asking for `facingMode: 'environment'`
 *      with `ideal` on a laptop silently returns the front camera, and the guard
 *      then believes they are scanning with the back one. So an explicit switch
 *      asks with `exact` and, if the browser refuses, we say "this device has one
 *      camera" instead of pretending.
 *   3. WHY IT FAILED. Denied, no camera, camera busy, or a page served over plain
 *      http (where `navigator.mediaDevices` does not exist at all) are four
 *      different problems with four different fixes, and a gate guard cannot
 *      debug "camera error".
 *
 * The chosen side is kept in `sessionStorage`: it survives a reload during a
 * shift and is gone when the browser is closed. It is a preference, not a
 * credential — the device secret lives in `deviceAuth.ts` and nothing here
 * touches it.
 */

export type Facing = "user" | "environment";

export type CameraFailure =
  | "denied"
  | "no_camera"
  | "in_use"
  | "unavailable"
  | "insecure_context"
  | "unsupported";

export interface CameraOpened {
  ok: true;
  stream: MediaStream;
  /** What was asked for. */
  requested: Facing;
  /**
   * What the track reports, when it reports anything. `null` means the browser
   * did not say (common on desktop) — the UI must not claim either way.
   */
  reported: Facing | null;
  /** Video inputs visible now that permission has been granted. */
  cameraCount: number;
  /** Human label of the track, for the "one camera" message. */
  label: string;
}

export type CameraResult = CameraOpened | { ok: false; failure: CameraFailure };

const FACING_KEY = "tt-kiosk-facing-v1";

/** Ideal capture size. Kept at 720p: a face two metres away must still clear the
 * pipeline's 120-pixel minimum, and the detector downscales to its own input
 * size anyway, so a smaller capture buys little and costs reach. */
const IDEAL_WIDTH = 1280;
const IDEAL_HEIGHT = 720;

export function loadFacingChoice(): Facing | null {
  try {
    const raw = sessionStorage.getItem(FACING_KEY);
    return raw === "user" || raw === "environment" ? raw : null;
  } catch {
    return null;
  }
}

export function saveFacingChoice(facing: Facing): void {
  try {
    sessionStorage.setItem(FACING_KEY, facing);
  } catch {
    // Private-mode storage refusal is not a reason to stop scanning.
  }
}

/** `true` when this browser can be asked for a camera at all. */
export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** Video inputs the browser will admit to. Zero when it refuses to say. */
export async function countVideoInputs(): Promise<number> {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.enumerateDevices !== "function") {
    return 0;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

function failureFor(err: unknown): CameraFailure {
  const name = typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no_camera";
    case "NotReadableError":
    case "AbortError":
      return "in_use";
    default:
      return "unavailable";
  }
}

function reportedFacing(stream: MediaStream): Facing | null {
  const track = stream.getVideoTracks()[0];
  if (track === undefined) return null;
  const settings = track.getSettings() as { facingMode?: string };
  return settings.facingMode === "user" || settings.facingMode === "environment"
    ? settings.facingMode
    : null;
}

function labelFor(stream: MediaStream): string {
  return stream.getVideoTracks()[0]?.label ?? "";
}

/**
 * Open one camera.
 *
 * `strict` is the difference between "start somewhere sensible" and "the guard
 * tapped Back Camera": with `strict: false` the constraint is `ideal`, so a
 * laptop with one webcam still works; with `strict: true` it is `exact`, so a
 * device that has no camera on that side answers `no_camera` and the UI can say
 * so truthfully instead of quietly showing the wrong lens.
 */
export async function openCamera(facing: Facing, strict: boolean): Promise<CameraResult> {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    // getUserMedia is unavailable outside a secure context. A kiosk "link" is
    // exactly the case where somebody opens http://192.168.x.x on a phone.
    return { ok: false, failure: "insecure_context" };
  }
  if (!cameraSupported()) return { ok: false, failure: "unsupported" };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: strict ? { exact: facing } : { ideal: facing },
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT },
      },
      audio: false,
    });
    return {
      ok: true,
      stream,
      requested: facing,
      reported: reportedFacing(stream),
      cameraCount: await countVideoInputs(),
      label: labelFor(stream),
    };
  } catch (err) {
    return { ok: false, failure: failureFor(err) };
  }
}

/** Stop every track. Called on unmount and before every switch — two live
 * streams on one phone is how the second `getUserMedia` starts failing with
 * NotReadableError. */
export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
