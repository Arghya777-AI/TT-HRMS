/**
 * Cursor values, against the names this venue actually employs.
 *
 * The old rule refused any value containing `( ) , . " ' \` and told the caller
 * to paginate on an id or a date instead. That held while every register sorted
 * by a code — and broke the moment one sorted by NAME, which is what a directory
 * should do. Every input below is a name shape on this deployment or one line
 * away from it.
 */
import { describe, expect, it } from "vitest";
import { cursorValue } from "./query";

describe("cursorValue", () => {
  it("leaves a uuid untouched", () => {
    // The common case: unchanged bytes, so every existing register keeps its URL.
    const id = "3f1d6f9e-0c2a-4f6b-9a3d-1b2c3d4e5f60";
    expect(cursorValue(id)).toBe(id);
  });

  it("leaves a code and a timestamp untouched", () => {
    expect(cursorValue("TT0018")).toBe("TT0018");
    expect(cursorValue("2026-08-11T09:30:00")).toBe("2026-08-11T09:30:00");
  });

  it("quotes a name with a space", () => {
    // A bare space is legal in PostgREST but ambiguous to read; quoting is safer
    // and costs nothing.
    expect(cursorValue("Suraj Kumar")).toBe('"Suraj Kumar"');
  });

  it("quotes initials, which carry a full stop", () => {
    expect(cursorValue("Raghu K.R.")).toBe('"Raghu K.R."');
  });

  it("quotes an apostrophe rather than refusing it", () => {
    expect(cursorValue("D'Souza")).toBe('"D\'Souza"');
  });

  it("quotes a comma, which would otherwise end the predicate", () => {
    /*
      This is the one that mattered: inside `or=(a.gt.X,and(...))` a bare comma
      would split the argument list and PostgREST would read the rest of the name
      as another filter.
    */
    expect(cursorValue("Rao, Suresh")).toBe('"Rao, Suresh"');
  });

  it("escapes an embedded double quote", () => {
    expect(cursorValue('He said "hi"')).toBe('"He said \\"hi\\""');
  });

  it("escapes a backslash before anything else", () => {
    // Escaped first, or the escape character itself gets double-escaped.
    expect(cursorValue("back\\slash")).toBe('"back\\\\slash"');
  });

  it("handles a name with parentheses", () => {
    expect(cursorValue("Priya (Contract)")).toBe('"Priya (Contract)"');
  });
});
