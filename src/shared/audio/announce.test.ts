/**
 * The gate must be heard when the internet is not there.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * During an outage the chime played and the spoken line did not, so the gate sounded half
 * broken and nobody heard "thank you". The chimes are oscillators generated on the device, so
 * they never needed a network; `speechSynthesis` did, because `utterance.lang = "en-IN"` asks
 * for a LANGUAGE and Android's best `en-IN` voices are NETWORK voices. The platform prefers
 * them, `speak()` raises nothing, `onerror` may never fire, and the foyer stays silent.
 *
 * `localService` is the flag that separates installed voices from remote ones. These tests pin
 * that an installed voice is always preferred, however much better a remote one sounds.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

interface FakeVoice {
  name: string;
  lang: string;
  localService: boolean;
}

const spoken: { voice: FakeVoice | undefined; text: string }[] = [];

function installSpeech(voices: FakeVoice[]): void {
  spoken.length = 0;
  class FakeUtterance {
    voice: FakeVoice | undefined;
    lang = "";
    volume = 1;
    rate = 1;
    pitch = 1;
    constructor(public text: string) {}
  }
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    speak: (u: FakeUtterance) => spoken.push({ voice: u.voice, text: u.text }),
    cancel: () => undefined,
    pending: false,
    speaking: false,
    addEventListener: () => undefined,
  });
}

/** Re-imported per test, because the chosen voice is cached at module scope on purpose. */
async function freshSpeak() {
  vi.resetModules();
  return (await import("./announce")).speak;
}

beforeEach(() => {
  vi.stubGlobal("window", globalThis as unknown as Window & typeof globalThis);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice selection", () => {
  it("prefers an INSTALLED en-IN voice over a better remote one", async () => {
    installSpeech([
      { name: "Google हिन्दी (network)", lang: "en-IN", localService: false },
      { name: "Rishi", lang: "en-IN", localService: true },
    ]);
    (await freshSpeak())("Thank you, your attendance is registered");
    expect(spoken[0]?.voice?.name).toBe("Rishi");
    expect(spoken[0]?.voice?.localService).toBe(true);
  });

  it("falls back to any installed English when en-IN is not installed", async () => {
    installSpeech([
      { name: "Google UK (network)", lang: "en-GB", localService: false },
      { name: "Samantha", lang: "en-US", localService: true },
    ]);
    (await freshSpeak())("Your inwards attendance is registered");
    expect(spoken[0]?.voice?.name).toBe("Samantha");
  });

  it("takes ANY installed voice over silence", async () => {
    /*
      An installed voice reading English badly is still audible, and audible is the whole
      requirement at a gate. Quality is not the trade being made here.
    */
    installSpeech([
      { name: "Google Network", lang: "en-IN", localService: false },
      { name: "Lekha", lang: "ml-IN", localService: true },
    ]);
    (await freshSpeak())("Authentication failed, try again");
    expect(spoken[0]?.voice?.name).toBe("Lekha");
  });

  it("leaves the platform to choose when nothing is installed", async () => {
    // Unchanged behaviour, so a device with only remote voices is no worse off than before.
    installSpeech([{ name: "Google Network", lang: "en-IN", localService: false }]);
    (await freshSpeak())("Your attendance is saved on this device");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.voice).toBeUndefined();
  });

  it("does not pin an answer while the voice list is still empty", async () => {
    /*
      `getVoices()` returns [] until the platform has enumerated. Caching that as "nothing
      installed" would pin the old, silent-offline behaviour for the whole session on the
      strength of one early call — and the first announcement of a session is often the one
      somebody is standing there listening to.
    */
    const voices: FakeVoice[] = [];
    installSpeech(voices);
    const speak = await freshSpeak();
    speak("first");
    expect(spoken[0]?.voice).toBeUndefined();

    voices.push({ name: "Rishi", lang: "en-IN", localService: true });
    speak("second");
    expect(spoken[1]?.voice?.name).toBe("Rishi");
  });
});

describe("it still refuses to break a punch", () => {
  it("says nothing for empty text rather than throwing", async () => {
    installSpeech([{ name: "Rishi", lang: "en-IN", localService: true }]);
    (await freshSpeak())("   ");
    expect(spoken).toHaveLength(0);
  });
});
