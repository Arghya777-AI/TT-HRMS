/**
 * chime.ts — the sound a gate makes when it has recorded somebody.
 *
 * ── WHY A SOUND AT ALL ───────────────────────────────────────────────────────
 * Nobody stops to read a wall-mounted screen. People walk at it, glance, and keep going —
 * often before the result card has finished appearing, and in a lobby where the screen may be
 * backlit or at a bad angle. A tone is the only confirmation that reaches somebody who is
 * already walking away, and it is the one that reaches them without looking.
 *
 * It is ADDITIVE. Every outcome still says what happened on screen, in words. A sound cannot
 * be the only channel: the gate is used by people with hearing loss, in a noisy foyer, and
 * with the tablet muted by whoever last picked it up.
 *
 * ── WHY IT IS SYNTHESISED AND NOT AN AUDIO FILE ──────────────────────────────
 * Because the gate has to work with no internet. A `.mp3` is one more asset to cache, to
 * version, to have evicted by the browser, and to fail silently when a service worker misses
 * it. Two oscillators and a gain envelope are a few hundred bytes of code, work offline
 * always, and cannot 404. It also keeps the tone identical on every device rather than
 * depending on a codec.
 *
 * ── THE iOS PROBLEM, WHICH IS THE REAL WORK HERE ─────────────────────────────
 * Safari will not produce sound until the user has interacted with the page — an autoplay
 * rule with no exception, and one that a wall-mounted terminal violates by its very nature:
 * nobody touches a gate before the first person walks up to it. So:
 *
 *   · The context is created lazily, on the first sound, not at import.
 *   · Every plausible first interaction — touch, pointer, key — tries to unlock it, and the
 *     listeners remove themselves once it works.
 *   · {@link chimeReady} reports whether sound can actually be produced, so the gate can
 *     show a one-time "tap to enable sound" rather than being mysteriously silent.
 *
 * `webkitAudioContext` is checked as well as `AudioContext`: Safari only dropped the prefix in
 * 14.1, and this product supports iOS 12.5.7.
 */
import { nowInstantIso } from "@/lib/datetime";

/** What just happened, which decides what it sounds like. */
export type ChimeKind =
  /** Attendance recorded. The one people are listening for. */
  | "recorded"
  /** Recognised, but inside the debounce window — nothing new was written. */
  | "duplicate"
  /** No internet: held on the device and will sync. Still a success for the person. */
  | "queued"
  /** Not recognised, or refused. */
  | "error";

const STORE_KEY = "tt-chime-muted";

interface Tone {
  /** Hz. */
  freq: number;
  /** Seconds from the start of the whole chime. */
  at: number;
  /** Seconds. */
  dur: number;
  /** 0–1, before the master volume. */
  gain: number;
}

/**
 * The four voices.
 *
 * Chosen to be distinguishable without being learned — rising means good, falling means
 * something is wrong, which is the one audio convention almost everybody already holds. The
 * frequencies sit in 500–1400 Hz, where a small tablet speaker is actually efficient and where
 * ambient foyer noise is weakest; a "nicer" low tone simply would not be heard.
 */
const VOICES: Record<ChimeKind, Tone[]> = {
  // Two rising notes, quick and bright. Reads as "done".
  recorded: [
    { freq: 880, at: 0, dur: 0.09, gain: 0.5 },
    { freq: 1320, at: 0.085, dur: 0.15, gain: 0.5 },
  ],
  // One flat note. Deliberately unremarkable: nothing was written, and it should not sound
  // like a second successful punch to somebody who scanned twice.
  duplicate: [{ freq: 880, at: 0, dur: 0.16, gain: 0.35 }],
  // Rising like a success, because for the person at the gate it IS one, then a soft third
  // note that says "not finished yet".
  queued: [
    { freq: 780, at: 0, dur: 0.09, gain: 0.45 },
    { freq: 1170, at: 0.085, dur: 0.1, gain: 0.45 },
    { freq: 980, at: 0.2, dur: 0.14, gain: 0.3 },
  ],
  // Two falling notes, lower and slower. Unmistakably not a success, without being alarming
  // — most "errors" here are a face the camera could not read, not a wrongdoing.
  error: [
    { freq: 540, at: 0, dur: 0.12, gain: 0.45 },
    { freq: 400, at: 0.13, dur: 0.22, gain: 0.45 },
  ],
};

/** Master volume. A gate is across a foyer; a phone is at arm's length. */
const VOLUME = 0.5;

type Ctor = new () => AudioContext;

function contextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  // Safari kept the prefix until 14.1, and iOS 12.5.7 is a supported target.
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let context: AudioContext | null = null;
let unlockBound = false;

function ensureContext(): AudioContext | null {
  if (context !== null) return context;
  const Ctx = contextCtor();
  if (Ctx === null) return null;
  try {
    context = new Ctx();
  } catch {
    // Some locked-down webviews expose the constructor and throw on construction.
    return null;
  }
  bindUnlock();
  return context;
}

/**
 * Try to resume the context on the next real interaction, whatever it is.
 *
 * `resume()` only succeeds inside a user-gesture task on Safari, so it cannot be called
 * hopefully from a timer. The listeners are passive, on `window`, and remove themselves the
 * moment the context is running — a gate left open for a week must not accumulate them.
 */
function bindUnlock(): void {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;

  const attempt = () => {
    const ctx = context;
    if (ctx === null) return;
    if (ctx.state === "running") {
      remove();
      return;
    }
    void ctx.resume().then(
      () => {
        if (ctx.state === "running") remove();
      },
      () => undefined,
    );
  };
  const remove = () => {
    for (const type of ["touchend", "pointerdown", "mousedown", "keydown"] as const) {
      window.removeEventListener(type, attempt);
    }
  };
  for (const type of ["touchend", "pointerdown", "mousedown", "keydown"] as const) {
    window.addEventListener(type, attempt, { passive: true });
  }
}

/** Whether this browser can make a sound at all. */
export function chimeSupported(): boolean {
  return contextCtor() !== null;
}

/**
 * Whether a sound would actually be heard right now.
 *
 * False while the context is suspended — i.e. before any interaction on iOS. The gate uses
 * this to offer a one-time prompt instead of being silently mute, which is the failure that
 * would otherwise be reported as "the sound does not work".
 */
export function chimeReady(): boolean {
  return context !== null && context.state === "running" && !isMuted();
}

export function isMuted(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORE_KEY) === "1";
  } catch {
    // Private browsing throws on access. Audible is the better default for a gate.
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(STORE_KEY, "1");
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Not persisting a preference is survivable; failing to punch is not.
  }
}

/**
 * Unlock audio from inside a user gesture.
 *
 * Call this from a real tap handler — a button's `onClick` — when you want the first sound of
 * the session to be audible. Outside a gesture it is harmless and does nothing.
 */
export function primeChime(): void {
  const ctx = ensureContext();
  if (ctx === null) return;
  if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
}

/**
 * Play one chime. Never throws, never awaits, never blocks a punch.
 *
 * A gate that failed to record attendance because a speaker was busy would be an absurd
 * trade, so every failure path here is a silent return. The visual result is the real
 * confirmation; this is the courtesy on top of it.
 */
export function playChime(kind: ChimeKind): void {
  if (isMuted()) return;
  const ctx = ensureContext();
  if (ctx === null) return;

  /*
    Suspended means iOS has not been unlocked yet. Ask — and give up on THIS chime, because
    `resume()` is asynchronous: re-reading `state` on the next line can never see the change,
    so a second check there is dead code that only looks like caution. The unlock listeners
    take it from here and the next punch is audible.
  */
  if (ctx.state !== "running") {
    void ctx.resume().catch(() => undefined);
    return;
  }

  try {
    const start = ctx.currentTime;
    for (const tone of VOICES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // A sine is the only waveform a small tablet speaker reproduces without buzzing.
      osc.type = "sine";
      osc.frequency.value = tone.freq;

      /*
        An envelope, not a bare on/off. Starting or stopping a non-zero gain instantly puts a
        step in the waveform, which is heard as a click — and on a cheap speaker the click is
        louder than the note. 8 ms up, ramp down to silence.
      */
      const t0 = start + tone.at;
      const peak = tone.gain * VOLUME;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + tone.dur + 0.02);
    }
  } catch {
    // Nothing about a punch depends on this succeeding.
  }
}

/**
 * Pick the sound from a punch result.
 *
 * One place decides, so the gate and the web app cannot drift into disagreeing about what a
 * duplicate sounds like.
 */
export function chimeForOutcome(outcome: {
  matched?: boolean;
  duplicateSuppressed?: boolean;
  queued?: boolean;
}): ChimeKind {
  if (outcome.queued === true) return "queued";
  if (outcome.matched !== true) return "error";
  return outcome.duplicateSuppressed === true ? "duplicate" : "recorded";
}

/**
 * Diagnostic string for the gate's own footer.
 *
 * Uses `nowInstantIso` only to keep this module's imports honest about the clock rule; the
 * timestamp is not part of the sound.
 */
export function chimeStatus(): string {
  if (!chimeSupported()) return "not supported";
  if (isMuted()) return "muted";
  if (context === null) return "idle";
  return context.state === "running" ? "ready" : `waiting for a tap (${nowInstantIso().slice(11, 19)})`;
}
