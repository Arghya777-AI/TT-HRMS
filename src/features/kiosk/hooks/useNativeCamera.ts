/**
 * useNativeCamera — the camera, when the gate is running inside the native iOS shell.
 *
 * Presents the same shape `useCamera` does, so the scan screen can hold one or the other
 * without knowing which. The difference is entirely in where the pixels come from:
 *
 *   `useCamera`        `getUserMedia` → a MediaStream → a <video> the loop reads.
 *   `useNativeCamera`  AVCaptureSession in the shell → its own preview layer behind the
 *                      WebView → one frame pulled across the bridge when JS asks.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * iOS 12 has no `getUserMedia` outside Safari — not in WKWebView (14.3), not in a
 * home-screen web app. On the iPad generation that tops out at iOS 12.5.7 there is no
 * browser API that reaches a camera, so the shell has to hold it.
 *
 * ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────
 * Recognition. The frame is handed to the same `readFrame` that runs in the browser, and the
 * descriptor comes out of the same ResNet-34 with the same alignment. That is deliberate and
 * load-bearing: the enrolled templates are in that model's vector space and nothing else can
 * be compared to them.
 */
import { useCallback, useEffect, useState } from "react";
import {
  installControlSink,
  installFrameSink,
  isNativeShell,
  nativeCameraPermission,
  nativeGrabFrame,
  nativeStartCamera,
  nativeStopCamera,
  type CameraFacing,
} from "../lib/nativeBridge";

export type NativeCameraStatus = "idle" | "starting" | "live" | "denied" | "unavailable";

export interface NativeCameraState {
  status: NativeCameraStatus;
  facing: CameraFacing;
}

export interface NativeCamera {
  /** True when a native shell is hosting this page at all. */
  present: boolean;
  state: NativeCameraState;
  /** Pull one frame. Null whenever there is nothing to give — same contract as a cold video. */
  grab: () => Promise<HTMLCanvasElement | null>;
  setFacing: (facing: CameraFacing) => void;
  retry: () => void;
}

/**
 * Which camera a gate should use by default.
 *
 * `back`, matching the web path's `environment`: a wall-mounted terminal points its rear
 * camera at the person walking up, and the front camera at the wall.
 */
const DEFAULT_FACING: CameraFacing = "back";

export function useNativeCamera(): NativeCamera {
  const present = isNativeShell();
  const [facing, setFacingState] = useState<CameraFacing>(DEFAULT_FACING);
  const [status, setStatus] = useState<NativeCameraStatus>(present ? "idle" : "unavailable");
  const [attempt, setAttempt] = useState(0);

  // The sinks are what the shell calls back into. Installed before any request, and
  // idempotent, so a re-render cannot stack handlers.
  useEffect(() => {
    if (!present) return;
    installFrameSink();
    installControlSink();
  }, [present]);

  useEffect(() => {
    if (!present) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    setStatus("starting");

    void (async () => {
      /*
        Permission first, then start. Asking the shell to start a session it has no
        permission for would leave the screen on "starting" forever with no explanation —
        the failure has to be attributable to a denial so the gate can say so.

        `unknown` is treated as worth trying: it means the shell did not answer, which is not
        a refusal, and the start attempt is the better source of truth.
      */
      const permission = await nativeCameraPermission();
      if (cancelled) return;
      if (permission === "denied") {
        setStatus("denied");
        return;
      }
      const started = nativeStartCamera(facing);
      if (cancelled) return;
      setStatus(started ? "live" : "unavailable");
    })();

    return () => {
      cancelled = true;
      nativeStopCamera();
    };
  }, [present, facing, attempt]);

  const grab = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    if (!present) return null;
    return await nativeGrabFrame();
  }, [present]);

  const setFacing = useCallback((next: CameraFacing) => {
    // The effect above restarts the session; no need to stop it here.
    setFacingState(next);
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { present, state: { status, facing }, grab, setFacing, retry };
}
