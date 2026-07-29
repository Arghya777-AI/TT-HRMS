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
import { t } from "@/shared/i18n/en";

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

/**
 * Why the microphone could not be opened. Each one has its own next step, which is the
 * entire reason this is not a boolean.
 */
type MicOutcome =
  | "granted"
  | "unavailable"
  | "insecure"
  | "blocked_site"
  | "dismissed_or_os"
  | "no_device"
  | "device_busy";

/**
 * One sentence per outcome. Kept as a table rather than a chain of ternaries so that
 * adding an outcome without giving it a sentence is a type error.
 */
const MIC_MESSAGE: Readonly<Record<Exclude<MicOutcome, "granted" | "unavailable">, Parameters<typeof t>[0]>> = {
  insecure: "ai.voice.err.insecure",
  blocked_site: "ai.voice.err.blockedSite",
  dismissed_or_os: "ai.voice.err.dismissed",
  no_device: "ai.voice.err.noDevice",
  device_busy: "ai.voice.err.busy",
};

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
  /**
   * How loud the microphone is hearing, 0–1, while listening. Drives the pulse. It is a
   * real measurement, so 0 while `listening` is true means the microphone is picking
   * nothing up — which is information, not a bug.
   */
  readonly level: number;
  /** Reader-facing sentence, already chosen for the failure that happened. */
  readonly error: string | null;
  /** Async: it asks the browser for the microphone before it starts listening. */
  readonly start: () => Promise<void>;
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
  /** 0–1 loudness, for the pulse. See the meter below. */
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<MinimalRecognition | null>(null);
  /*
    Whether `getUserMedia` has already SUCCEEDED in this session. It changes what
    `not-allowed` from the recogniser can honestly mean — see the error handler.
  */
  const micGranted = useRef(false);
  // The callback is read at event time, so a re-render with a new closure does not
  // require tearing down the recogniser.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported = recognitionCtor() !== null;
  const isCloudRecognition = supported &&
    /Chrome|Chromium|Edg/.test(navigator.userAgent) &&
    !/Safari\/[\d.]+$/.test(navigator.userAgent.replace(/Chrome.*/, ""));

  /** True while the reader wants to keep listening. `onend` reads it to decide to restart. */
  const wantListening = useRef(false);
  /** Guards a restart loop when the service refuses instantly. */
  const lastRestart = useRef(0);

  /*
    ── THE PULSE IS THE REAL VOICE, NOT AN ANIMATION ─────────────────────────────

    A CSS keyframe pulse would be one line and would be lying: it pulses identically
    whether somebody is talking, silent, or has walked away. The whole value of the
    indicator is telling the reader "I can hear you" — and its most useful moment is when
    the answer is "actually, I cannot", because the microphone is muted at the OS or they
    are too far from it. A constant animation cannot say that.

    So a WebAudio analyser reads the stream and the level drives the ring.

    A SECOND STREAM is held for this, alongside the one the recogniser opens for itself.
    That is deliberate: `SpeechRecognition` exposes no audio, so there is nothing to tap.
    The browser shows one recording indicator either way, and both are released together.

    STATE IS UPDATED AT ~15Hz, not per frame. `requestAnimationFrame` runs at 60, and 60
    React renders a second to move a ring is waste; at 15 the motion is still smooth to the
    eye. The value is also rounded, so a still room does not re-render on noise-floor jitter.
  */
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream; raf: number } | null>(null);

  const stopAudioMeter = useCallback(() => {
    const live = audio.current;
    audio.current = null;
    setLevel(0);
    if (live === null) return;
    cancelAnimationFrame(live.raf);
    for (const track of live.stream.getTracks()) track.stop();
    void live.ctx.close().catch(() => {
      // Already closed, or the context was never running. Nothing to report.
    });
  }, []);

  const startAudioMeter = useCallback(() => {
    if (audio.current !== null) return;
    const media = navigator.mediaDevices;
    if (media === undefined || typeof media.getUserMedia !== "function") return;

    void media.getUserMedia({ audio: true }).then((stream) => {
      // The reader may have pressed stop while permission was resolving.
      if (!wantListening.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx === undefined) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      // Small window: this is a loudness meter, not a spectrogram, and a short buffer
      // follows speech onsets closely instead of smearing them.
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const buffer = new Uint8Array(analyser.fftSize);
      let lastPush = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        // RMS around the 128 midpoint of the unsigned byte waveform.
        let sum = 0;
        for (const sample of buffer) {
          const centred = (sample - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const now = performance.now();
        if (now - lastPush > 66) {
          lastPush = now;
          // ×4 so ordinary speech reaches the top of the range rather than a twitch, and
          // rounded so a quiet room does not re-render on noise-floor jitter.
          setLevel(Math.round(Math.min(1, rms * 4) * 20) / 20);
        }
        const live = audio.current;
        if (live !== null) live.raf = requestAnimationFrame(tick);
      };
      audio.current = { ctx, stream, raf: requestAnimationFrame(tick) };
    }).catch(() => {
      // The meter is decoration. Dictation still works without it, so a failure here is
      // silent rather than an error the reader has to read.
    });
  }, []);

  // Never leave the microphone open across an unmount.
  useEffect(() => () => {
    wantListening.current = false;
    ref.current?.abort();
    ref.current = null;
    stopAudioMeter();
  }, [stopAudioMeter]);

  const stop = useCallback(() => {
    // Intent first: `onend` reads this to decide whether to restart, and it can fire
    // synchronously from `stop()`.
    wantListening.current = false;
    stopAudioMeter();
    ref.current?.stop();
    setListening(false);
  }, [stopAudioMeter]);

  /**
   * ASK THE BROWSER FIRST.
   *
   * This is the bug that made the microphone button useless: `SpeechRecognition.start()`
   * does NOT reliably raise the permission dialog in Chrome. On a page whose microphone
   * permission has never been decided it can go straight to `onerror` with
   * `not-allowed` — so the reader was told "microphone access was blocked, allow it in
   * your browser settings" having never been asked for it, and there was nothing in
   * settings to change because no decision had been recorded.
   *
   * `getUserMedia` is what actually prompts. So it is called first, purely to make the
   * browser ask, and the stream is stopped IMMEDIATELY — recognition opens its own, and
   * holding this one would leave a second recording indicator lit for no reason.
   *
   * It must stay inside the click handler's call stack to count as a user gesture, which
   * is why this is awaited by `start` rather than run in an effect somewhere.
   */
  /**
   * ASK THE BROWSER, AND FIND OUT EXACTLY WHY IF IT SAYS NO.
   *
   * `SpeechRecognition.start()` does not reliably raise the permission dialog in Chrome —
   * `getUserMedia` is what prompts, so it is called first and its stream stopped at once
   * (recognition opens its own; holding this one lights a second recording indicator).
   *
   * WHY IT REPORTS A REASON RATHER THAN A BOOLEAN. "Microphone access was blocked. Allow it
   * in your browser settings" was shown for every possible refusal, and it sent somebody
   * to a settings page that had nothing wrong in it — three separate times, because each
   * of these needs a DIFFERENT action and they are indistinguishable from the outside:
   *
   *   · the site is blocked in Chrome     → the padlock in the address bar, not settings
   *   · the prompt was dismissed          → press the button again and choose Allow
   *   · macOS is blocking Chrome itself   → System Settings, and no prompt ever appears
   *   · there is no microphone            → nothing to allow
   *   · another app holds the microphone  → close it
   *
   * `permissions.query` distinguishes the first from the rest: a `denied` state means a
   * remembered site-level block, which is the only case where "browser settings" is even
   * the right place to look. The DOMException name separates the others.
   */
  const requestMicrophone = useCallback(async (): Promise<MicOutcome> => {
    const media = navigator.mediaDevices;
    if (media === undefined || typeof media.getUserMedia !== "function") {
      // No getUserMedia at all: let recognition try on its own rather than refusing here.
      return "unavailable";
    }
    if (!window.isSecureContext) return "insecure";

    // Whether a decision is already remembered for this site, before we ask.
    let priorState: string | null = null;
    try {
      const status = await navigator.permissions.query(
        { name: "microphone" } as unknown as PermissionDescriptor,
      );
      priorState = status.state;
    } catch {
      // Firefox and older Safari do not support querying it. Not knowing is fine.
    }

    try {
      const stream = await media.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      micGranted.current = true;
      return "granted";
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "Error";
      // Logged so a screenshot is not the only diagnostic available.
      console.error("microphone request refused", { name, priorState });
      if (name === "NotFoundError" || name === "OverconstrainedError") return "no_device";
      if (name === "NotReadableError" || name === "AbortError") return "device_busy";
      if (priorState === "denied") return "blocked_site";
      // NotAllowedError with no remembered block: either the prompt was dismissed, or the
      // operating system is refusing Chrome and no prompt was ever shown.
      return "dismissed_or_os";
    }
  }, []);

  const start = useCallback(async () => {
    const Ctor = recognitionCtor();
    if (Ctor === null) {
      setError(t("ai.voice.err.unsupported"));
      return;
    }
    setError(null);

    const outcome = await requestMicrophone();
    if (outcome !== "granted" && outcome !== "unavailable") {
      setError(t(MIC_MESSAGE[outcome]));
      return;
    }
    // The reader is now in charge of when it stops. Set BEFORE the recogniser exists, so
    // an `onend` that arrives immediately still sees the intent.
    wantListening.current = true;
    startAudioMeter();

    const rec = new Ctor();
    rec.lang = RECOGNITION_LANG;
    /*
      CONTINUOUS, AND RESTARTED WHEN THE BROWSER GIVES UP.

      It used to be one phrase and close, on the reasoning that an always-on microphone is
      not a feature. That is right for a microphone nobody asked to open and wrong for one
      the reader just turned on: somebody dictating "how many days did I work in June, and
      how does that compare with May" pauses in the middle, and a recogniser that closes at
      the first pause takes half the question and stops.

      `continuous = true` is not enough on its own. Chrome ends the session after a stretch
      of silence regardless, so `onend` restarts it while the reader still wants it — which
      is what turns "one phrase" into "until you press stop".
    */
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      const { text, final } = transcriptFrom(event);
      // APPENDED, not replaced: in continuous mode each phrase is its own result, and the
      // second sentence of a question must not overwrite the first.
      if (final && text !== "") onTextRef.current(text);
    };
    rec.onerror = (event) => {
      const code = (event as { error?: string }).error ?? "";
      // Each of these needs a different action from the reader, so each says something
      // different. "not-allowed" especially: the fix is in browser settings, not here.
      /*
        `not-allowed` AND `service-not-allowed` ARE NOT THE SAME REFUSAL, and lumping them
        together produced a wrong instruction. `not-allowed` is the microphone permission,
        which the reader can grant. `service-not-allowed` is Chrome's speech SERVICE
        declining — no API key, an unsupported build, an enterprise policy — and there is
        nothing in browser settings for them to change. Telling somebody to fix a
        permission they already granted is worse than telling them it is unavailable.
      */
      /*
        `not-allowed` AFTER A GRANTED MICROPHONE IS NOT A PERMISSION PROBLEM.

        Found while testing: with the microphone permission granted and `getUserMedia`
        succeeding, the recogniser still reported `not-allowed`. Chrome uses that code for
        its speech SERVICE being unavailable too — no API key in the build, an enterprise
        policy, an automation context. So when we KNOW the microphone was granted a moment
        ago, telling somebody to go and allow a permission they have already allowed sends
        them into settings to find nothing wrong. It reports unavailability instead.
      */
      setError(
        code === "not-allowed" && !micGranted.current
          ? t("ai.voice.err.blockedSite")
          : code === "service-not-allowed" || code === "audio-capture"
          ? t("ai.voice.err.service")
          : code === "no-speech"
          ? t("ai.voice.err.silence")
          : code === "network"
          ? t("ai.voice.err.network")
          : t("ai.voice.err.generic"),
      );
      /*
        A FATAL CODE STOPS; A TRANSIENT ONE DOES NOT. `no-speech` is the commonest event in
        continuous mode — it simply means a quiet stretch — and treating it as fatal is what
        would make the microphone close while somebody was drawing breath. So it leaves
        `wantListening` alone and lets `onend` restart. Everything else ends the session.
      */
      if (code !== "no-speech" && code !== "aborted") {
        wantListening.current = false;
        stopAudioMeter();
        setListening(false);
      }
    };
    rec.onend = () => {
      if (!wantListening.current) {
        stopAudioMeter();
        setListening(false);
        return;
      }
      /*
        Restart, with a floor on how often. If the service refuses instantly this would spin
        as fast as the event loop allows, so a restart that follows the previous one inside
        400ms is treated as a failure to stay open and the session ends rather than looping.
      */
      const now = performance.now();
      if (now - lastRestart.current < 400) {
        wantListening.current = false;
        stopAudioMeter();
        setListening(false);
        setError(t("ai.voice.err.generic"));
        return;
      }
      lastRestart.current = now;
      try {
        rec.start();
      } catch {
        wantListening.current = false;
        stopAudioMeter();
        setListening(false);
      }
    };

    ref.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // Calling start() twice throws; treat it as already listening rather than an error.
      setListening(true);
    }
  }, [requestMicrophone, startAudioMeter, stopAudioMeter]);

  return { supported, isCloudRecognition, listening, level, error, start, stop };
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
