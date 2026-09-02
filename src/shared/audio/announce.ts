/**
 * announce.ts — the gate says out loud what it just recorded.
 *
 * ── WHY SPEECH AND NOT ONLY A TONE ───────────────────────────────────────────
 * A tone confirms that SOMETHING happened. It cannot say what. At a gate the difference
 * between an in-punch and an out-punch is the whole of the record, and the person walking
 * through is the only one who can catch it being wrong — but only if they are told, and only
 * if they are told without having to stop and read a screen they are already past.
 *
 * So: tone first, then words. The tone turns a head; the words inform the head that turned.
 * They never overlap, because two sources at once are unintelligible on a tablet speaker.
 *
 * ── WHY THE SYSTEM VOICE AND NOT RECORDED AUDIO ──────────────────────────────
 * The gate has to work with no internet, so recorded clips would have to be cached, versioned
 * and kept from being evicted — for every sentence, in every language this venue ever adds.
 * `speechSynthesis` uses voices already on the device: nothing to download, nothing to go
 * missing, and a new sentence is a new string rather than a new asset and a new deploy.
 *
 * The cost is that the voice differs between devices. For "your inwards attendance is
 * registered" that is a fair trade; nobody is judging the timbre.
 *
 * ── INSIDE THE APP IT IS NATIVE ──────────────────────────────────────────────
 * Same reason as the tones. WKWebView inherits Safari's autoplay rule and honours the device
 * mute, and a wall-mounted gate is touched by nobody and muted by everybody. `AVSpeechSynthesizer`
 * behind a `.playback` audio session has neither problem.
 */
import { chimeDurationMs, isMuted, playChime, type ChimeKind } from "./chime";

/**
 * A spoken line is cancelled if it is still going when the next person arrives.
 *
 * A gate at shift change sees somebody every two or three seconds. Queued utterances would
 * fall further and further behind until the terminal was announcing arrivals from a minute
 * ago — worse than silence, because it is confidently wrong about who just walked through.
 * The newest announcement is the only one worth hearing.
 */
function cancelPending(): void {
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Some webviews expose the object and throw on use.
  }
}

export function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (window.TTGateNative !== undefined) return true;
  return typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * Say one line. Never throws, never awaits, never blocks a punch.
 *
 * Delegates to the native shell when there is one; otherwise uses the browser's own voice.
 */
/**
 * The voice this device will use, chosen once and remembered.
 *
 * ── WHY CHOOSING MATTERS, AND WHY IT WAS SILENT AT THE GATE ──────────────────
 * `utterance.lang = "en-IN"` asks for a language; it does NOT ask for an offline voice. Android
 * ships Google's `en-IN` voices as NETWORK voices — synthesised server-side — and the platform
 * prefers them because they sound better. With no internet, `speak()` is called, no error is
 * raised, `onerror` may never fire, and nothing is heard.
 *
 * Which is exactly what the gate did during an outage: the chime played, because those are
 * oscillators generated on the device, and then the spoken line — the "thank you" people listen
 * for — did not arrive. The tone alone is indistinguishable from a gate that half works.
 *
 * `localService` is the flag that separates the two. A local voice is installed on the device
 * and speaks with no network at all, so it is preferred over any remote voice however much
 * better the remote one sounds. A gate is not a place for audio quality; it is a place for
 * being heard.
 *
 * ── ORDER OF PREFERENCE ──────────────────────────────────────────────────────
 *   1. local + en-IN    the venue's own English, installed
 *   2. local + any en   any installed English
 *   3. local + anything an installed voice reading English badly is still audible
 *   4. undefined        let the platform decide, which is the old behaviour
 *
 * Nothing here forces a download and nothing fails loudly: a device with only remote voices
 * ends up at (4) and behaves exactly as before.
 */
let chosenVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | undefined {
  // `undefined` = not looked yet; `null` = looked and found nothing worth pinning.
  if (chosenVoice !== undefined) return chosenVoice ?? undefined;

  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = window.speechSynthesis.getVoices();
  } catch {
    return undefined;
  }
  /*
    `getVoices()` is empty until the platform has enumerated them, which on Chrome happens
    after a `voiceschanged` event. Returning undefined leaves `chosenVoice` unset so the NEXT
    announcement looks again — the alternative, caching the empty answer, would pin the old
    behaviour forever on the strength of one early call.
  */
  if (voices.length === 0) return undefined;

  const local = voices.filter((v) => v.localService);
  const found =
    local.find((v) => v.lang.replace("_", "-").toLowerCase() === "en-in") ??
    local.find((v) => v.lang.toLowerCase().startsWith("en")) ??
    local[0];

  chosenVoice = found ?? null;
  return found;
}

/*
  Re-pick when the platform finishes enumerating. Without this the first announcement of a
  session — often the one somebody is standing there listening to — falls back to the platform
  default because the list was not ready yet.
*/
if (typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined") {
  try {
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      chosenVoice = undefined;
      pickVoice();
    });
  } catch {
    // Safari has no such event; its list is ready synchronously.
  }
}

export function speak(text: string): void {
  if (isMuted() || text.trim() === "") return;
  if (typeof window === "undefined") return;

  // The shell speaks for us: no autoplay rule, and audible on a muted device.
  if (window.TTGateNative !== undefined) {
    void import("@/features/kiosk/lib/nativeBridge")
      .then(({ nativeSpeak }) => nativeSpeak(text))
      .catch(() => undefined);
    return;
  }

  if (!speechSupported()) return;

  try {
    cancelPending();
    const utterance = new SpeechSynthesisUtterance(text);
    // en-IN so a device with Indian English installed uses it; harmlessly ignored otherwise.
    utterance.lang = "en-IN";
    /*
      An INSTALLED voice, when there is one. This is the line that makes the gate audible during
      an outage: without it the platform may pick a network voice and say nothing at all.
    */
    const voice = pickVoice();
    if (voice !== undefined) utterance.voice = voice;
    utterance.volume = 1;
    /*
      Slightly slower than default. This is heard once, in a foyer, by somebody already
      walking — at the default rate the difference between "inwards" and "outwards", which is
      the only word that matters, is easy to miss.
    */
    utterance.rate = 0.95;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Nothing about a punch depends on this.
  }
}

/**
 * The whole announcement: the tone, then the words.
 *
 * `text` is resolved by the caller so this module never touches i18n — the gate and the web
 * app pass their own translated line, and adding a language does not mean editing audio code.
 * Pass null for outcomes that should stay wordless.
 */
export function announcePunch(kind: ChimeKind, text: string | null): void {
  playChime(kind);
  if (text === null || text.trim() === "") return;

  /*
    Wait out the tone before speaking. `chimeDurationMs` is the real length of the voice that
    was just played, not a guess, so this stays correct if a tone is ever re-tuned — and the
    +90 ms is a breath, so the two do not butt against each other.
  */
  window.setTimeout(() => speak(text), chimeDurationMs(kind) + 90);
}
