/**
 * SubmitBlockers — one way to say "you cannot send this yet", on every form.
 *
 * ── WHY A DISABLED BUTTON IS THE WRONG ANSWER ────────────────────────────────
 *
 * Reported twice: "so it should show when user click otherwise how we will know
 * about this error??" and then, of the asset form, "send for approval button is
 * disable … enable this type of button for across each routes".
 *
 * It is not only a preference. A disabled button does not fire a click AT ALL —
 * so pressing it produces nothing: no message, no focus change, nothing for a
 * screen reader to announce. The person is left to guess which of a dozen fields
 * is wrong, and the hint that would tell them is usually several fields above,
 * where nobody connects it to the button they just pressed.
 *
 * So: the button stays live. Pressing it with something outstanding reveals the
 * list, scrolls to it and moves focus there. Pressing it when everything is in
 * order submits.
 *
 * ── WHY IT LIVES HERE AND NOT IN EACH PAGE ───────────────────────────────────
 *
 * Eight forms had eight copies of the amber-box-and-disabled-button pattern, each
 * subtly different — one scrolled, one did not, one was a `<p>`, one an `<ul>`.
 * The behaviour people rely on is now in one file, so "the red box" means the
 * same thing on the asset form as on leave.
 *
 * RED, not amber. Amber reads as advice; this is a refusal, and it was reported
 * as wanting to be a "red color box".
 */
import { useCallback, useRef, useState, type RefObject } from "react";

export interface SubmitAttempt {
  /** True once the person has pressed the button with something outstanding. */
  readonly attempted: boolean;
  /**
   * Call from the button. Returns true when the form is clear to submit, so the
   * caller reads `if (!attempt.press(blockers)) return;`.
   */
  readonly press: (blockers: readonly string[]) => boolean;
  /** Clear it after a successful submit, so the next attempt starts quiet. */
  readonly reset: () => void;
  /** Put on the blocker box. Focus and scrolling need the node. */
  readonly ref: RefObject<HTMLDivElement | null>;
}

/**
 * The attempt state for one form.
 *
 * `attempted` is what keeps the list quiet until it is asked for: nobody needs
 * "say how many days" before they have had a chance to type anything. After the
 * first press the list stays live, so fixing a field makes its line disappear.
 */
export function useSubmitAttempt(): SubmitAttempt {
  const [attempted, setAttempted] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const press = useCallback((blockers: readonly string[]): boolean => {
    if (blockers.length === 0) return true;
    setAttempted(true);
    /*
      Reveal AND go to it. On a phone the box can be off-screen above the button,
      and a message nobody scrolls to is the same as no message. The frame delay
      is so the node exists before we reach for it — it is rendered by the same
      state change.
    */
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      ref.current?.focus();
    });
    return false;
  }, []);

  const reset = useCallback(() => setAttempted(false), []);
  return { attempted, press, reset, ref };
}

export interface SubmitBlockersProps {
  readonly attempt: SubmitAttempt;
  readonly blockers: readonly string[];
  /** Must be unique on the page; two forms on one screen need two ids. */
  readonly id: string;
  readonly title: string;
}

/**
 * The box. Renders nothing until the button has been pressed with a blocker
 * outstanding — `role="alert"` so assistive tech announces it on appearance
 * rather than waiting to be navigated to.
 */
export function SubmitBlockers({ attempt, blockers, id, title }: SubmitBlockersProps) {
  if (!attempt.attempted || blockers.length === 0) return null;
  return (
    <div
      id={id}
      ref={attempt.ref as RefObject<HTMLDivElement>}
      tabIndex={-1}
      role="alert"
      className="mt-3 rounded-md border border-destructive/60 bg-destructive/5 p-3 text-xs outline-none"
    >
      <p className="font-medium text-destructive">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {blockers.map((blocker) => (
          <li key={blocker}>{blocker}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The props a live submit button needs to be describable.
 *
 * Spread onto the button so the accessibility tree ties it to the box: without
 * this the control is announced with no reason attached, which is the disabled
 * button's problem wearing different clothes.
 */
export function blockerButtonProps(
  attempt: SubmitAttempt,
  blockers: readonly string[],
  id: string,
): { "aria-invalid": boolean; "aria-describedby"?: string } {
  const blocked = attempt.attempted && blockers.length > 0;
  return blocked ? { "aria-invalid": true, "aria-describedby": id } : { "aria-invalid": false };
}
