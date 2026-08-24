/**
 * nativeBridge.ts — the seam between the gate web app and a native iOS shell.
 *
 * ── WHY A NATIVE SHELL EXISTS AT ALL ─────────────────────────────────────────
 * One reason, and it is not "apps are nicer": **iOS 12 has no `getUserMedia` outside
 * Safari.** WKWebView did not get it until iOS 14.3, and a home-screen web app never had
 * it. So on the iPad Air 1 / mini 2-3 generation — iOS 12.5.7, the last release those
 * devices will ever run — the gate can only reach a camera through NATIVE code. A wrapper
 * that merely loads the site would be strictly worse than a Safari tab.
 *
 * ── WHAT THE SHELL DELIBERATELY DOES NOT DO ──────────────────────────────────
 * It does not recognise faces. The enrolled templates in `secure.face_templates` are 128-D
 * ResNet-34 descriptors produced by face-api.js with a specific detector input size and a
 * specific landmark-aligned crop. Anything else — Apple's Vision framework, a reimplemented
 * model, even the same model fed a differently-aligned crop — produces a vector in a
 * different space and matches NOBODY. The repo already records that changing the detector
 * input size alone silently breaks matching; a model port is that hazard several times over.
 *
 * So the descriptor keeps being computed by the exact code that enrolled everyone, in the
 * WebView. Native contributes the two things a browser on iOS 12 cannot: a camera, and a
 * window without a URL bar.
 *
 * ── PULL, NOT PUSH ───────────────────────────────────────────────────────────
 * The obvious design streams every frame into JavaScript. That is a lot of base64 across a
 * bridge for pixels whose only purpose is to be looked at. Instead:
 *
 *   · NATIVE draws the live preview itself, in an `AVCaptureVideoPreviewLayer` behind the
 *     WebView. Smooth, hardware-composited, costs the bridge nothing.
 *   · JAVASCRIPT pulls ONE frame when it actually needs pixels — a few times a second while
 *     tracking, then once more for the frame that becomes a descriptor.
 *
 * The scan loop's own budget is unchanged; only the source of the pixels moves.
 *
 * ── ABSENT BY DEFAULT ────────────────────────────────────────────────────────
 * Every export here is a no-op in a normal browser. `isNativeShell()` is false, the gate
 * uses `useCamera` and a `<video>` exactly as before, and nothing in this file runs. It is
 * additive: the web path is not routed through the bridge and cannot be broken by it.
 */

/** What the shell injects at document start. Version is a contract, not decoration. */
interface NativeShell {
  /** Bumped when the message vocabulary changes, so JS can refuse a shell too old to talk to. */
  version: number;
  platform: "ios";
  /** OS version string, e.g. "12.5.7" — for diagnostics, never for behaviour. */
  osVersion?: string;
}

interface WebKitBridge {
  messageHandlers?: {
    ttGate?: { postMessage: (message: unknown) => void };
  };
}

declare global {
  interface Window {
    TTGateNative?: NativeShell;
    webkit?: WebKitBridge;
    /** Native calls this to answer a frame request. Installed by {@link installFrameSink}. */
    __ttGateFrame?: (dataUrl: string, width: number, height: number) => void;
  }
}

/** The lowest shell version this build knows how to speak to. */
const MIN_SHELL_VERSION = 1;

/**
 * A single frame request may not outlive this.
 *
 * The scan loop awaits a frame; a bridge that never answers would hang it forever and the
 * gate would sit on a live preview recording nothing. Two seconds is far longer than a
 * capture needs and short enough that a wedged shell surfaces as a scan failure.
 */
const FRAME_TIMEOUT_MS = 2_000;

export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const shell = window.TTGateNative;
  return shell !== undefined && shell.version >= MIN_SHELL_VERSION;
}

/** The shell's own description, for the diagnostics line. Null in a browser. */
export function nativeShellInfo(): NativeShell | null {
  return isNativeShell() ? (window.TTGateNative ?? null) : null;
}

function post(message: unknown): boolean {
  const handler = window.webkit?.messageHandlers?.ttGate;
  if (handler === undefined) return false;
  try {
    handler.postMessage(message);
    return true;
  } catch {
    // A shell that has torn down its handler must not take the scan loop with it.
    return false;
  }
}

/**
 * Ask the shell to make the attendance sound.
 *
 * ── WHY THE APP PLAYS IT AND NOT THE WEB LAYER ───────────────────────────────
 * Safari — and WKWebView with it — refuses to produce sound until the page has been
 * interacted with. A wall-mounted gate is touched by nobody: the person walking up is
 * recognised without contact. So inside the shell, Web Audio would be reliably mute until
 * somebody remembered to tap the screen, which is the one thing an unattended terminal
 * cannot depend on.
 *
 * Native audio has no such rule. The shell also puts its audio session in the playback
 * category, so the chime is heard even when the iPad has been muted from Control Centre —
 * which, on a device left on a wall for a month, it eventually will be.
 *
 * Returns false when there is no shell, and the caller falls back to Web Audio.
 */
export function nativePlaySound(kind: string): boolean {
  if (!isNativeShell()) return false;
  return post({ op: "playSound", kind });
}

/**
 * Ask the shell to speak a line.
 *
 * Same reasoning as {@link nativePlaySound}: `speechSynthesis` inside WKWebView inherits
 * Safari's autoplay rule and honours the device mute, so on an untouched wall-mounted terminal
 * it is reliably silent. `AVSpeechSynthesizer` behind a `.playback` session has neither
 * problem. The TEXT is chosen by the web layer — the shell knows nothing about attendance and
 * has no copy of its own to drift out of date.
 */
export function nativeSpeak(text: string): boolean {
  if (!isNativeShell()) return false;
  return post({ op: "speak", text });
}

export type CameraFacing = "front" | "back";

/** Ask the shell to start its capture session and show the preview. */
export function nativeStartCamera(facing: CameraFacing): boolean {
  return post({ op: "startCamera", facing });
}

export function nativeStopCamera(): boolean {
  return post({ op: "stopCamera" });
}

/**
 * Whether the shell has been granted camera permission.
 *
 * Resolves `"unknown"` in a browser or when the shell does not answer, because a missing
 * answer is not a denial and the caller must not render a permission error on a guess.
 */
export type NativeCameraPermission = "granted" | "denied" | "unknown";

let permissionResolve: ((value: NativeCameraPermission) => void) | null = null;

export function nativeCameraPermission(): Promise<NativeCameraPermission> {
  if (!isNativeShell()) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    permissionResolve = resolve;
    const sent = post({ op: "cameraPermission" });
    if (!sent) {
      permissionResolve = null;
      resolve("unknown");
      return;
    }
    window.setTimeout(() => {
      if (permissionResolve === resolve) {
        permissionResolve = null;
        resolve("unknown");
      }
    }, FRAME_TIMEOUT_MS);
  });
}

/** Called by the shell. Exported so the sink installer can wire it. */
function deliverPermission(value: NativeCameraPermission): void {
  const resolve = permissionResolve;
  permissionResolve = null;
  if (resolve !== null) resolve(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frames
// ─────────────────────────────────────────────────────────────────────────────

let pending: ((frame: { dataUrl: string; width: number; height: number } | null) => void) | null =
  null;

/**
 * Install the callback the shell uses to hand a frame back.
 *
 * Called once, from the gate's entry, before any scan starts. Idempotent: re-installing
 * replaces the same property rather than stacking listeners.
 */
export function installFrameSink(): void {
  if (typeof window === "undefined") return;
  window.__ttGateFrame = (dataUrl: string, width: number, height: number) => {
    const resolve = pending;
    pending = null;
    if (resolve === null) return; // A late answer to a timed-out request. Drop it.
    resolve({ dataUrl, width, height });
  };
}

/**
 * The canvas the pulled frames land on, reused for every grab.
 *
 * One canvas, not one per frame: at a few grabs a second a fresh canvas each time is
 * megabytes of garbage a minute on a device with 1 GB of RAM.
 */
let sink: HTMLCanvasElement | null = null;

function canvas(width: number, height: number): HTMLCanvasElement {
  if (sink === null) sink = document.createElement("canvas");
  // Only resize on an actual change — assigning width/height clears the canvas and
  // reallocates its backing store.
  if (sink.width !== width) sink.width = width;
  if (sink.height !== height) sink.height = height;
  return sink;
}

/**
 * Pull one frame from the shell and return it as a canvas face-api can read.
 *
 * Null when there is no shell, the request was not delivered, it timed out, or the image
 * failed to decode — every one of which the caller treats as "no face this frame", the same
 * as a `<video>` that is not ready yet. A frame source is allowed to have nothing to say.
 */
export async function nativeGrabFrame(): Promise<HTMLCanvasElement | null> {
  if (!isNativeShell()) return null;
  // One request in flight. A second would resolve the first's promise with the wrong frame.
  if (pending !== null) return null;

  const frame = await new Promise<{ dataUrl: string; width: number; height: number } | null>(
    (resolve) => {
      pending = resolve;
      if (!post({ op: "grabFrame" })) {
        pending = null;
        resolve(null);
        return;
      }
      window.setTimeout(() => {
        if (pending === resolve) {
          pending = null;
          resolve(null);
        }
      }, FRAME_TIMEOUT_MS);
    },
  );
  if (frame === null) return null;

  const image = await decode(frame.dataUrl).catch(() => null);
  if (image === null) return null;

  const width = frame.width > 0 ? frame.width : image.width;
  const height = frame.height > 0 ? frame.height : image.height;
  const target = canvas(width, height);
  const context = target.getContext("2d");
  if (context === null) return null;
  context.drawImage(image, 0, 0, width, height);
  return target;
}

/**
 * Decode a data URL.
 *
 * `Image` with `onload` rather than `createImageBitmap`: that landed in Safari 15 and this
 * whole file exists for Safari 12.
 */
function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("frame did not decode"));
    image.src = dataUrl;
  });
}

/**
 * The shell's inbound entry point for everything that is not a frame.
 *
 * Kept to one function with a tagged payload so adding a message never means teaching the
 * shell about another global.
 */
export function installControlSink(): void {
  if (typeof window === "undefined") return;
  const target = window as unknown as {
    __ttGateControl?: (message: { type: string; value?: string }) => void;
  };
  target.__ttGateControl = (message) => {
    if (message.type === "cameraPermission") {
      deliverPermission(
        message.value === "granted" ? "granted" : message.value === "denied" ? "denied" : "unknown",
      );
    }
  };
}
