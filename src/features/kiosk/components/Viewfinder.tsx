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
 */
import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import type { Facing } from "../lib/camera";

export function Viewfinder({
  videoRef,
  facing,
  dim,
  children,
  className,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  facing: Facing;
  /** Darken the feed so overlaid text stays legible in daylight. */
  dim?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-2xl border border-neutral-800 bg-black",
        className,
      )}
    >
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
      {children !== undefined ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-end p-3">
          <div className="pointer-events-auto">{children}</div>
        </div>
      ) : null}
    </div>
  );
}
