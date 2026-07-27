/**
 * gateCopy.ts — the pipeline's refusal reasons, in the gate's voice, in one place.
 *
 * Both the guard's own scan and the queue loop hit the same four quality gates, so
 * the sentence a person reads must be the same on both screens — two copies would
 * drift and the guard would learn two vocabularies for one problem. These reuse the
 * `kiosk.scan.*` lines that already shipped rather than restating them.
 */
import { t } from "@/shared/i18n/en";
import type { FrameVerdict } from "./facePipeline";
import type { GateSignal } from "./gateScanner";

/** What to tell the person in front of the camera about THIS frame. */
export function guidanceLine(verdict: FrameVerdict): string {
  switch (verdict.kind) {
    case "many_faces":
      return t("kiosk.scan.oneAtATime");
    case "poor":
      switch (verdict.reason) {
        case "too_small":
          return t("kiosk.scan.stepCloser");
        case "too_dark":
          return t("kiosk.scan.tooDark");
        case "too_blurry":
          return t("kiosk.scan.holdStill");
        case "low_score":
          return t("kiosk.scan.faceCamera");
      }
      break;
    case "no_face":
    case "ok":
      return t("kiosk.gate.scan.prompt");
  }
  return t("kiosk.gate.scan.prompt");
}

/** The same, for a live loop signal. */
export function signalLine(signal: GateSignal): string {
  switch (signal.kind) {
    case "many_faces":
      return t("kiosk.scan.oneAtATime");
    case "step_closer":
      return t("kiosk.scan.stepCloser");
    case "guidance":
      return guidanceLine(signal.verdict);
    case "tracking":
      return t("kiosk.gate.scan.tracking");
    case "capturing":
      return t("kiosk.gate.scan.capturing");
    case "idle":
      return t("kiosk.gate.scan.prompt");
  }
}
