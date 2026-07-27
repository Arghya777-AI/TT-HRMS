/**
 * reveal.ts — the ONE session-scoped "Show amounts" gate for E-08.
 *
 * spec-employee §8 (PII masking): salary is masked as `₹•,••,•••` behind a
 * *session toggle* — not a per-field eye icon on twenty rows, and not a
 * preference. So the state lives here:
 *
 *  - **In module memory only.** No localStorage, no sessionStorage, no cookie,
 *    no query param. A reload, a new tab, or closing the tab re-masks. There is
 *    deliberately no persistence code to audit.
 *  - **Shared across the pay screens.** Revealing on `/me/payslips` and opening
 *    a payslip does not ask again — it is one reveal for the session, which is
 *    what the spec's "session toggle" means. Navigating away and back does not
 *    silently re-reveal either: what survives is the *timer*, not a preference.
 *  - **Time-boxed, with the remaining time on screen.** The window closes
 *    itself, so an unattended shared phone in a kitchen passage re-masks
 *    without anyone remembering to press Hide (spec §8 field conditions).
 *
 * Audit gap, stated rather than faked: the only reveal-logging entry points the
 * deployed DB exposes (`reveal_employee_salary`, `reveal_employee_statutory`,
 * migration 032) require `app.is_admin()` and a ≥10-character reason, so an
 * employee revealing their OWN already-fetched figures has no server endpoint
 * to write `pii.revealed` through. Nothing here pretends otherwise; when a
 * self-reveal audit RPC exists, call it from `reveal()` and nowhere else.
 */
import { useCallback, useEffect, useState } from "react";
import { fmtMmSs } from "@/lib/datetime";

/** How long one reveal lasts. Long enough to read a payslip, short enough to walk away from. */
export const REVEAL_WINDOW_SECONDS = 300;

/** Epoch ms at which the reveal lapses. `null` = masked. Module memory ONLY. */
let revealedUntilMs: number | null = null;

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Whole seconds left, floored at 0. 0 means "masked". */
function remainingSeconds(): number {
  if (revealedUntilMs === null) return 0;
  const left = Math.ceil((revealedUntilMs - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function startTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(() => {
    if (remainingSeconds() === 0) {
      revealedUntilMs = null;
      stopTicker();
    }
    emit();
  }, 1000);
}

export interface AmountReveal {
  /** True while money may be rendered in the clear. */
  readonly revealed: boolean;
  /** Whole seconds left in the window; 0 when masked. */
  readonly secondsLeft: number;
  /** 'm:ss' for the visible countdown, via lib/datetime. */
  readonly countdown: string;
  /** How long a reveal lasts, in whole minutes — for the explanatory hint. */
  readonly windowMinutes: number;
  /** Open the window (or restart it — pressing Show again tops the timer up). */
  readonly reveal: () => void;
  /** Re-mask immediately. */
  readonly hide: () => void;
}

/**
 * Subscribe a screen to the session reveal.
 *
 * Every money-bearing component on the page reads `revealed` from here and
 * passes it to `<Money masked>` / `<MaskedValue masked>`, so there is exactly
 * one control and no component can opt itself out of masking.
 */
export function useAmountReveal(): AmountReveal {
  const [secondsLeft, setSecondsLeft] = useState<number>(remainingSeconds);

  useEffect(() => {
    const sync = (): void => setSecondsLeft(remainingSeconds());
    listeners.add(sync);
    // A reveal started on the previous screen is still running: pick the timer
    // back up rather than showing a frozen countdown.
    if (remainingSeconds() > 0) startTicker();
    sync();
    return () => {
      listeners.delete(sync);
      if (listeners.size === 0) stopTicker();
    };
  }, []);

  const reveal = useCallback(() => {
    revealedUntilMs = Date.now() + REVEAL_WINDOW_SECONDS * 1000;
    startTicker();
    emit();
  }, []);

  const hide = useCallback(() => {
    revealedUntilMs = null;
    stopTicker();
    emit();
  }, []);

  return {
    revealed: secondsLeft > 0,
    secondsLeft,
    countdown: fmtMmSs(secondsLeft),
    windowMinutes: Math.round(REVEAL_WINDOW_SECONDS / 60),
    reveal,
    hide,
  };
}

/** Test-only reset so a spec does not inherit another spec's open window. */
export function __resetAmountRevealForTests(): void {
  revealedUntilMs = null;
  stopTicker();
  emit();
}
