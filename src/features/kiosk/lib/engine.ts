/**
 * engine.ts — when the face engine loads, which is half of "recognise very
 * quickly".
 *
 * The weights are ~6.7 MB (tiny_face_detector 193 KB, face_landmark_68_tiny
 * 77 KB, face_recognition 6.4 MB) served from THIS origin out of
 * `public/models/v1/`. Measured cold load from local disk: 42 ms; over a phone
 * connection it is dominated by the 6.4 MB recognition net.
 *
 * So the load is started at page MOUNT — during pairing, during the guard's PIN
 * entry, whatever is happening — instead of when the scan screen appears. By the
 * time a queue forms the nets are in memory. `loadFaceModels` memoises its own
 * promise, so calling it early costs nothing and calling it again is free.
 */
import { loadFaceModels } from "./facePipeline";

export type EngineStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed" };

/** Kick the download off. Safe to call any number of times. */
export function warmFaceEngine(): Promise<void> {
  return loadFaceModels().then(() => undefined);
}
