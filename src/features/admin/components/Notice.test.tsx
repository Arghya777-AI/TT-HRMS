/**
 * Notice.test.tsx — the distinction between "act on this" and "this is how it is".
 *
 * WHY THIS FILE EXISTS, IN THE CLIENT'S WORDS
 * -------------------------------------------
 * Looking at a permanent architectural footnote on the analytics dashboard, drawn
 * in amber behind a warning triangle:
 *
 *   "why this type error is coming and do we need to fix it or is it issue due to
 *    not having real data??"
 *
 * The answer was no on both counts. It was a standing note about three tables
 * nobody has built — nothing to do with their data, and nothing an administrator
 * could act on. But it LOOKED like a fault, and a warning triangle that never
 * clears is how people learn to ignore warning triangles, and then miss the one
 * that mattered.
 *
 * So `note` exists, and these tests keep the two apart: a note must stay quiet
 * and must not be announced as though something just happened.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice } from "./Notice";

describe("Notice", () => {
  it("announces an error as an alert", () => {
    // An error interrupted something the user was doing; it earns the interruption.
    render(<Notice tone="error">Could not save</Notice>);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  });

  it("announces a warning as a status", () => {
    render(<Notice tone="warning">No last working day is recorded</Notice>);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("marks a standing note as a note, not a status and not an alert", () => {
    /*
      `role="note"` rather than `role="status"`: a permanent footnote is not a
      live region, and announcing it on every render tells a screen-reader user
      that something changed when nothing did.
    */
    render(<Notice tone="note">This view cannot be sliced by department.</Notice>);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("draws a note in muted colours rather than amber", () => {
    // The whole point. If a note ever picks up the warning palette it becomes
    // the thing this file was written to stop.
    const { container } = render(<Notice tone="note">A standing fact</Notice>);
    const box = container.firstElementChild;
    expect(box?.className).toContain("bg-muted");
    expect(box?.className).not.toContain("warning");
    expect(box?.className).not.toContain("destructive");
  });

  it("keeps warning amber, so the two remain distinguishable", () => {
    const { container } = render(<Notice tone="warning">Act on this</Notice>);
    expect(container.firstElementChild?.className).toContain("warning");
  });
});
