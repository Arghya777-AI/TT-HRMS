/**
 * The fallback path is the one that matters here.
 *
 * `crypto.randomUUID` exists in the test runtime, so a naive test only ever exercises the
 * branch that was never broken. Each case below removes it deliberately, which is the state
 * of an iPad on iOS earlier than 15.4 — the device this exists for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuid } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `crypto` with no `randomUUID`, i.e. Safari before 15.4. */
function withoutRandomUUID(): void {
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
  });
}

describe("uuid", () => {
  it("uses the platform generator when there is one", () => {
    const spy = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID: spy, getRandomValues: () => undefined });
    expect(uuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("produces a well-formed v4 without randomUUID", () => {
    withoutRandomUUID();
    for (let i = 0; i < 200; i += 1) expect(uuid()).toMatch(V4);
  });

  it("sets the version and variant bits, not just random hex", () => {
    withoutRandomUUID();
    const id = uuid();
    // Position 14 is the version nibble; position 19 is the variant.
    expect(id[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("does not collide across many draws", () => {
    withoutRandomUUID();
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(uuid());
    // A truncated or constant-seeded fallback shows up here immediately.
    expect(seen.size).toBe(5_000);
  });

  it("pads bytes below 0x10 instead of dropping a digit", () => {
    // All-zero bytes are the case a missing padStart would shorten to 20 characters.
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => array.fill(0),
    });
    expect(uuid()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("says why it cannot work when Web Crypto is absent entirely", () => {
    vi.stubGlobal("crypto", undefined);
    // A bare TypeError on an unattended terminal tells nobody anything.
    expect(() => uuid()).toThrow(/HTTPS/);
  });
});
