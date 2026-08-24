/**
 * What the gate says, and when it says it.
 *
 * The risk in this module is never "did a sound come out" — it is the gate confidently
 * announcing the wrong thing. A person walking away cannot check the screen, so the sentence
 * IS the record as far as they are concerned. These tests pin the three ways it could lie:
 * speaking over its own tone so neither is intelligible, announcing a refusal as a success,
 * and stacking utterances until it is describing somebody who left a minute ago.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return await import("./announce");
}

interface SpokenUtterance {
  text: string;
  volume: number;
  rate: number;
  lang: string;
}

/** A speechSynthesis stub that records what it was asked to say. */
function stubSpeech() {
  const spoken: SpokenUtterance[] = [];
  const cancel = vi.fn();
  vi.stubGlobal("speechSynthesis", {
    cancel,
    speak: (u: SpokenUtterance) => spoken.push(u),
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      volume = 1;
      rate = 1;
      pitch = 1;
      lang = "";
      constructor(text: string) {
        this.text = text;
      }
    },
  );
  // Silence the tone path; this file is about the words.
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          connect() {},
          start() {},
          stop() {},
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
        };
      }
    },
  );
  return { spoken, cancel };
}

afterEach(() => {
  try {
    localStorage.removeItem("tt-chime-muted");
  } catch {
    /* jsdom always has it */
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("speaking", () => {
  it("says the line, at full volume, in Indian English", async () => {
    const { spoken } = stubSpeech();
    const { speak } = await load();
    speak("Your inwards attendance is registered.");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe("Your inwards attendance is registered.");
    expect(spoken[0]!.volume).toBe(1);
    expect(spoken[0]!.lang).toBe("en-IN");
    // Slightly under default: "inwards" versus "outwards" is the whole message.
    expect(spoken[0]!.rate).toBeLessThan(1);
  });

  it("cancels whatever is still being said", async () => {
    const { cancel } = stubSpeech();
    const { speak } = await load();
    speak("first");
    speak("second");
    /*
      At shift change somebody arrives every few seconds. Queued utterances would fall behind
      until the gate was announcing arrivals from a minute ago — confidently wrong about who
      just walked through, which is worse than silence.
    */
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("says nothing when muted", async () => {
    const { spoken } = stubSpeech();
    const { speak } = await load();
    const { setMuted } = await import("./chime");
    setMuted(true);
    speak("Your attendance is registered.");
    expect(spoken).toHaveLength(0);
  });

  it("says nothing for an empty line", async () => {
    const { spoken } = stubSpeech();
    const { speak } = await load();
    speak("   ");
    expect(spoken).toHaveLength(0);
  });

  it("never throws where there is no speech engine", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    const { speak, speechSupported } = await load();
    expect(speechSupported()).toBe(false);
    // A punch must not fail because a device has no voice installed.
    expect(() => speak("anything")).not.toThrow();
  });
});

describe("announcePunch", () => {
  it("speaks AFTER the tone, never over it", async () => {
    vi.useFakeTimers();
    const { spoken } = stubSpeech();
    const { announcePunch } = await load();
    const { chimeDurationMs } = await import("./chime");

    announcePunch("recorded", "Your inwards attendance is registered.");
    // Nothing said yet: the tone is still playing, and two sources at once are unintelligible
    // on a tablet speaker.
    expect(spoken).toHaveLength(0);

    vi.advanceTimersByTime(chimeDurationMs("recorded") + 90);
    expect(spoken).toHaveLength(1);
  });

  it("stays wordless when given no line", async () => {
    vi.useFakeTimers();
    const { spoken } = stubSpeech();
    const { announcePunch } = await load();
    // An unrecognised face is the loud three-note fall and nothing else — a sentence over it
    // would only delay the next attempt.
    announcePunch("error", null);
    vi.advanceTimersByTime(5_000);
    expect(spoken).toHaveLength(0);
  });
});
