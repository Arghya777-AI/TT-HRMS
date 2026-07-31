/**
 * shiftWindow.ts — the one-line way to name a shift on screen.
 *
 * Its own module rather than a second export beside `AssignShiftCard`, because a file
 * that exports both a component and a helper breaks fast refresh for the component. It
 * is also the right shape: naming a shift is not specific to assigning one.
 *
 * A shift is NEVER shown as a bare code (spec §3.3) — the name carries the meaning and
 * the window carries the fact an employee actually needs, which is when they start.
 */
import { fmtCivilTime } from "@/lib/datetime";

export function shiftWindowLabel(
  name: string | null,
  startTime: string | null,
  endTime: string | null,
): string | null {
  if (name === null) return null;
  if (startTime === null || endTime === null) return name;
  return `${name} · ${fmtCivilTime(startTime)} – ${fmtCivilTime(endTime)}`;
}
