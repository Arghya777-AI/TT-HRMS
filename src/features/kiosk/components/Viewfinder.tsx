/**
 * Viewfinder — the live camera, with the overlay drawn on top of it.
 *
 * Two details that matter at a gate:
 *   * MIRRORED ONLY ON THE FRONT CAMERA. People expect a mirror when looking at
 *     themselves; a mirrored BACK camera makes the guard aim the wrong way.
 *   * The element stays mounted even when the camera has failed, so the stream
 *     can be attached the instant a retry succeeds (a `srcObject` assignment
 *     against a null ref is the classic reason a retry appears to do nothing).
 *     `aria-hidden` because a video of a face is not information a screen reader
 *     can use — the banner text is.
 *
 * ── THE NATIVE SHELL PUNCHES A HOLE INSTEAD ──────────────────────────────────
 * Inside the iOS app there is no `getUserMedia` to fill a <video> with — that is the whole
 * reason the app exists — so the camera is an `AVCaptureVideoPreviewLayer` sitting BEHIND
 * the WebView. For it to be visible, this element must be genuinely transparent rather than
 * merely empty: a black background would hide the preview completely and look exactly like
 * a dead camera.
 *
 * `bg-transparent` on the frame and no <video> at all. The overlay children still render on
 * top, so the guidance text and the result card read the same in both hosts.
 */
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import type { Facing } from "../lib/camera";

export function Viewfinder({
  videoRef,
  facing,
  dim,
  native = false,
  children,
  className,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  facing: Facing;
  /** Darken the feed so overlaid text stays legible in daylight. */
  dim?: boolean;
  /**
   * True when a native shell is drawing the camera behind this element. The frame goes
   * transparent and the <video> is not rendered — see the header.
   */
  native?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-2xl border border-neutral-800",
        native ? "bg-transparent" : "bg-black",
        className,
      )}
      // The shell finds the preview's position by measuring this element, so it needs a
      // stable way to identify it that class names cannot accidentally change.
      data-tt-gate-viewfinder={native ? "native" : undefined}
    >
      {native ? null : (
        <video
          ref={videoRef}
          muted
          playsInline
          aria-hidden
          className={cn(
            "h-full w-full object-cover",
            facing === "user" && "-scale-x-100",
            dim === true ? "opacity-70" : "opacity-95",
          )}
        />
      )}
      {children !== undefined ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-end p-3">
          <div className="pointer-events-auto">{children}</div>
        </div>
      ) : null}
    </div>
  );
}
