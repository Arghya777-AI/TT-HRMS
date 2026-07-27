/**
 * useReasonPrompt — the tiny state machine behind every `<ReasonDialog>` on an
 * admin screen: "which row am I about to change, and is the dialog open?".
 *
 * It exists so that no screen keeps two loosely-coupled pieces of state (an
 * `open` boolean and a `target`) that can disagree — a dialog open with a stale
 * target is how one admin's reason lands on another row's audit entry.
 *
 * The dialog itself clears its textarea on every open (ReasonDialog does that),
 * so a reason can never be carried from one change to the next.
 */
import { useCallback, useState } from "react";

export interface ReasonPrompt<T> {
  /** The pending change, or null when nothing is being asked about. */
  readonly target: T | null;
  readonly isOpen: boolean;
  /** Open the dialog for this change. */
  readonly ask: (target: T) => void;
  /** Close and forget the target (Cancel, or after a successful save). */
  readonly close: () => void;
}

export function useReasonPrompt<T>(): ReasonPrompt<T> {
  const [target, setTarget] = useState<T | null>(null);

  const ask = useCallback((next: T) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);

  return { target, isOpen: target !== null, ask, close };
}
