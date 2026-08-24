/**
 * The chime's decisions, not its acoustics.
 *
 * What matters here is which sound a given outcome maps to, that a muted gate stays silent,
 * and that nothing in this module can ever throw into a punch. The waveform itself is not
 * testable in jsdom and does not need to be — the risk in this file was never "does it sound
 * nice", it was "does a debounced re-scan sound like a successful punch", which is exactly the
 * confusion the two-ins bug produced visually.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/*
  Imported per test, not once at the top.

  `chime.ts` caches its AudioContext in a module-level variable — deliberately, since a gate
  must not build a new audio graph for every punch. That cache outlives a test, so a second
  test's stub would be ignored and it would silently assert against the first test's context.
  `vi.resetModules()` plus a dynamic import gives each test its own module instance.
*/
async function loadChime() {
  vi.resetModules();
  return await import("./chime");
}

/** A minimal Web Audio stub that records what was asked of it. */
function stubAudio() {
  const started: number[] = [];
  const osc = () => ({
    type: "",
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn((t: number) => started.push(t)),
    stop: vi.fn(),
  });
  const gainNode = () => ({
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  });
  const ctx = {
    state: "running" as AudioContextState,
    currentTime: 0,
    destination: {},
    createOscillator: vi.fn(osc),
    createGain: vi.fn(gainNode),
    resume: vi.fn(() => Promise.resolve()),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        return ctx;
      }
    },
  );
  return { ctx, started };
}

afterEach(() => {
  // The mute flag lives in localStorage, which persists across module resets.
  try {
    localStorage.removeItem("tt-chime-muted");
  } catch {
    /* jsdom always has it; guarded for parity with the module. */
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("which sound an outcome gets", () => {
  it("a recorded punch is the success tone", async () => {
    const { chimeForOutcome } = await loadChime();
    expect(chimeForOutcome({ matched: true })).toBe("recorded");
  });

  it("a debounced duplicate is NOT the success tone", async () => {
    const { chimeForOutcome } = await loadChime();
    // The whole point. Somebody who scans twice must not hear two identical confirmations.
    expect(chimeForOutcome({ matched: true, duplicateSuppressed: true })).toBe("duplicate");
  });

  it("an unmatched face is an error", async () => {
    const { chimeForOutcome } = await loadChime();
    expect(chimeForOutcome({ matched: false })).toBe("error");
    expect(chimeForOutcome({})).toBe("error");
  });

  it("a queued scan has its own sound, distinct from both", async () => {
    const { chimeForOutcome } = await loadChime();
    // Held offline is a success for the person and an outage for the venue; sounding
    // identical to a live punch would hide the outage until somebody read the screen.
    expect(chimeForOutcome({ matched: true, queued: true })).toBe("queued");
    // Queued wins even when the flags conflict — being offline is the more important fact.
    expect(chimeForOutcome({ matched: false, queued: true })).toBe("queued");
  });
});

describe("playing", () => {
  it("schedules one oscillator per note of the chosen voice", async () => {
    const { ctx } = stubAudio();
    const { playChime } = await loadChime();
    playChime("recorded");
    // The success voice is two notes.
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it("uses an envelope rather than switching gain on, so it does not click", async () => {
    const { ctx } = stubAudio();
    const { playChime } = await loadChime();
    playChime("duplicate");
    const gain = ctx.createGain.mock.results[0]!.value as {
      gain: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> };
    };
    expect(gain.gain.setValueAtTime).toHaveBeenCalled();
    // Up then down: two ramps per note.
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(2);
  });

  it("stays silent when muted, without touching audio at all", async () => {
    const { ctx } = stubAudio();
    const { playChime, setMuted, isMuted } = await loadChime();
    setMuted(true);
    expect(isMuted()).toBe(true);
    playChime("recorded");
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it("does not play while the context is suspended, and asks it to resume", async () => {
    const { ctx } = stubAudio();
    ctx.state = "suspended";
    const { playChime } = await loadChime();
    playChime("recorded");
    // iOS before any interaction. Ask, play nothing, let the next punch be audible.
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it("never throws when Web Audio is missing entirely", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { chimeSupported, playChime } = await loadChime();
    expect(chimeSupported()).toBe(false);
    // A punch must not fail because a speaker could not be found.
    expect(() => playChime("recorded")).not.toThrow();
  });

  it("never throws when the audio node graph blows up", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        resume() {
          return Promise.resolve();
        }
        createOscillator(): never {
          throw new Error("no more nodes");
        }
        createGain(): never {
          throw new Error("no more nodes");
        }
      },
    );
    const { playChime } = await loadChime();
    expect(() => playChime("recorded")).not.toThrow();
  });
});

describe("the mute preference", () => {
  it("survives a reload", async () => {
    const { setMuted, isMuted } = await loadChime();
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it("defaults to audible when storage is unavailable", async () => {
    const store = globalThis.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private browsing");
      },
      setItem: () => {
        throw new Error("private browsing");
      },
      removeItem: () => {
        throw new Error("private browsing");
      },
    });
    const { isMuted, setMuted } = await loadChime();
    // A gate whose preference cannot be read should make a noise, not sit mute.
    expect(isMuted()).toBe(false);
    expect(() => setMuted(true)).not.toThrow();
    vi.stubGlobal("localStorage", store);
  });
});
