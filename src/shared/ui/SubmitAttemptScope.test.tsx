/**
 * A mandatory field left empty goes red — but only after the button is pressed.
 *
 * Asked for: "if user has not filled any mandatory field across the website then
 * mark it is red when user is submitting form".
 *
 * The mechanism is deliberately made of two facts that already exist rather than
 * a third one to maintain: the control's own native `required` attribute, and a
 * `data-submit-attempted` marker stamped by the scope. The colouring itself is
 * one CSS rule in index.css keyed off `:invalid`, so the browser decides what
 * "empty and required" means and this codebase never holds a second opinion.
 *
 * These tests guard the WIRING, which is the part that can silently come apart:
 * a scope that never stamps, or stamps before the press, breaks the whole
 * feature while every form still renders perfectly.
 */
// `fireEvent` rather than a bare .click(): the state update has to be inside
// act(), or the assertion runs against the pre-render DOM.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubmitAttemptScope, useSubmitAttempt, useSubmitAttempted } from "./SubmitBlockers";

/** A form whose button reports a blocker, so `press` fails and marks the attempt. */
function Form({ blockers }: { readonly blockers: readonly string[] }) {
  const attempt = useSubmitAttempt();
  return (
    <SubmitAttemptScope attempt={attempt}>
      <input aria-label="who" required defaultValue="" />
      <button type="button" onClick={() => attempt.press(blockers)}>
        Send
      </button>
      <Echo />
    </SubmitAttemptScope>
  );
}

/** Proves the CONTEXT half reaches a child, which is what the Field atoms read. */
function Echo() {
  return <span data-testid="echo">{useSubmitAttempted() ? "attempted" : "clean"}</span>;
}

function marker(): HTMLElement | null {
  return document.querySelector("[data-submit-attempted]");
}

describe("SubmitAttemptScope", () => {
  it("marks nothing before the button is pressed", () => {
    render(<Form blockers={["Say why you need it."]} />);
    /*
      The important half. A form that reddens fields the moment it loads is
      shouting at somebody about boxes they have not reached yet, which is worse
      than saying nothing.
    */
    expect(marker()).toBeNull();
    expect(screen.getByTestId("echo").textContent).toBe("clean");
  });

  it("marks the scope once a press finds something missing", () => {
    render(<Form blockers={["Say why you need it."]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(marker()).not.toBeNull();
    expect(screen.getByTestId("echo").textContent).toBe("attempted");
  });

  it("does NOT mark the scope when the press succeeds", () => {
    // Nothing outstanding: `press` returns true and the form submits. Colouring
    // fields on a successful submit would be a lie about a form that was fine.
    render(<Form blockers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(marker()).toBeNull();
  });

  it("leaves the native required attribute for the CSS rule to act on", () => {
    /*
      The rule is `[data-submit-attempted="true"] :is(input,select,textarea):invalid`.
      jsdom does not apply stylesheets, so what is asserted here is the two
      things the rule needs — the marker above, and `required` on the control.
    */
    render(<Form blockers={["Say why you need it."]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const field = screen.getByLabelText("who");
    expect(field).toBeRequired();
    expect(field).toBeInvalid();
  });
});
