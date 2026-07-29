/**
 * useVoice — dictate a question, and hear the answer read back.
 *
 * BROWSER-NATIVE, NO NEW SERVICE. Both halves use APIs already in the browser: the Web
 * Speech API for recognition and `speechSynthesis` for playback. That is a deliberate
 * choice over sending audio to a transcription service, and the reason is what the
 * audio would contain — somebody dictating "why was my salary short in June" is
 * speaking about their own pay in a room with other people. Recognition here never
 * leaves the device on Safari and iOS; on Chrome the recognition step does go to
 * Google, which is why `isCloudRecognition` exists and the UI says so rather than
 * implying the microphone is private everywhere.
 *
 * WHAT IS NOT DONE, on purpose:
 *   · No auto-send. Recognition mishears names and numbers constantly — "Aadhaar"
 *     becomes "adhere", "Sri" becomes "three" — and a question sent without being read
 *     costs a wrong answer plus the tokens. Dictation fills the box; the person sends.
 *   · No continuous listening. The microphone opens when asked and closes on the first
 *     complete phrase or on stop. An always-on microphone in an HR tool is not a
 *     feature.
 *   · No speaking of tables. `speechSynthesis` reading a fifteen-row roster aloud is
 *     unusable; only the narrative is spoken, which is the part written as sentences.
 *
 * WHY IT IS ALL OPTIONAL. Firefox has no SpeechRecognition at all, and several Android
 * browsers have synthesis without recognition. Everything below reports what is
 * actually available rather than assuming, so a missing API hides a button instead of
 * throwing on click.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The vendor-prefixed constructor, typed only as far as this file uses it. The DOM lib
 * does not declare SpeechRecognition, and a full ambient declaration would claim more
 * than any one browser implements.
 */
interface MinimalRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => MinimalRecognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * en-IN, not en-US.
 *
 * This matters more than it looks: the questions are full of Indian names, "Aadhaar",
 * "PAN", "lakh", "crore" and place names like Avalahalli. A US model transcribes those
 * into nonsense, and the person retypes the whole question — which is worse than
 * having no dictation, because they tried first.
 */
const RECOGNITION_LANG = "en-IN";

/** Extract the best final transcript from the event, without trusting its shape. */
function transcriptFrom(event: unknown): { text: string; final: boolean } {
  const e = event as {
    results?: ArrayLike<ArrayLike<{ transcript?: string }> & { isFinal?: boolean }>;
    resultIndex?: number;
  };
  const results = e.results;
  if (results === undefined) return { text: "", final: false };
  let text = "";
  let final = false;
  for (let i = 0; i < results.length; i += 1) {
    const alt = results[i]?.[0];
    if (alt?.transcript !== undefined) text += alt.transcript;
    if (results[i]?.isFinal === true) final = true;
  }
  return { text: text.trim(), final };
}

export interface VoiceInput {
  /** False when the browser has no SpeechRecognition (Firefox, some Android). */
  readonly supported: boolean;
  /**
   * True on Chromium, where recognition is performed by a Google service rather than
   * on the device. Surfaced so the UI can say so — the audio is somebody talking about
   * their own pay.
   */
  readonly isCloudRecognition: boolean;
  readonly listening: boolean;
  /** Reader-facing sentence, already chosen for the failure that happened. */
  readonly error: string | null;
  readonly start: () => void;
  readonly stop: () => void;
}

/**
 * Dictation into a text box.
 *
 * `onText` receives the transcript when a phrase completes. It is called with the
 * FINAL text only — streaming interim results into the input makes the box flicker and
 * rewrite itself under the reader, and the phrase is short enough that waiting costs
 * nothing.
 */
export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<MinimalRecognition | null>(null);
  // The callback is read at event time, so a re-render with a new closure does not
  // require tearing down the recogniser.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported = recognitionCtor() !== null;
  const isCloudRecognition = supported &&
    /Chrome|Chromium|Edg/.test(navigator.userAgent) &&
    !/Safari\/[\d.]+$/.test(navigator.userAgent.replace(/Chrome.*/, ""));

  // Never leave the microphone open across an unmount.
  useEffect(() => () => {
    ref.current?.abort();
    ref.current = null;
  }, []);

  const stop = useCallback(() => {
    ref.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (Ctor === null) {
      setError("This browser cannot listen. Type the question instead.");
      return;
    }
    setError(null);
    const rec = new Ctor();
    rec.lang = RECOGNITION_LANG;
    // One phrase, then close. See the header: an always-on microphone is not wanted.
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      const { text, final } = transcriptFrom(event);
      if (final && text !== "") onTextRef.current(text);
    };
    rec.onerror = (event) => {
      const code = (event as { error?: string }).error ?? "";
      // Each of these needs a different action from the reader, so each says something
      // different. "not-allowed" especially: the fix is in browser settings, not here.
      setError(
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access was blocked. Allow it in your browser settings, then try again."
          : code === "no-speech"
          ? "I did not hear anything. Try again, a little closer to the microphone."
          : code === "network"
          ? "Speech recognition needs a network connection and could not reach it."
          : "Dictation stopped unexpectedly. Type the question instead.",
      );
      setListening(false);
    };
    rec.onend = () => setListening(false);

    ref.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // Calling start() twice throws; treat it as already listening rather than an error.
      setListening(true);
    }
  }, []);

  return { supported, isCloudRecognition, listening, error, start, stop };
}

export interface VoiceOutput {
  readonly supported: boolean;
  readonly speaking: boolean;
  readonly speak: (text: string) => void;
  readonly stop: () => void;
}

/**
 * Read an answer aloud.
 *
 * `speechSynthesis` is on the device, so nothing is sent anywhere. Only the narrative
 * should be passed in — see the header on why tables are not spoken.
 *
 * MARKDOWN IS STRIPPED FIRST. The narrative is markdown-lite, and a synthesiser says
 * "star star nine star star days" if you hand it the raw string.
 */
export function useVoiceOutput(): VoiceOutput {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => () => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!supported) return;
    // Cancel first: queuing a second answer on top of the first is never what somebody
    // pressing "read this" means.
    window.speechSynthesis.cancel();

    const plain = text
      .replace(/\*\*|__|\*|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") return;

    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.lang = RECOGNITION_LANG;
    // Slightly under default: figures and names are the point of these answers and the
    // default rate runs them together.
    utterance.rate = 0.95;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [supported]);

  return { supported, speaking, speak, stop };
}
