/**
 * useInstallApp — can this device install the app with one tap, and if not, why not.
 *
 * ── THE EVENT IS CAUGHT IN `index.html`, NOT HERE ────────────────────────────
 * `beforeinstallprompt` fires once, early, typically while the app bundle is still
 * downloading. A listener added in a React effect misses it, and a missed event cannot be
 * recovered — which meant the one-tap button would never appear and every employee was pushed
 * to the manual steps. The document head stashes the event on `window.__ttInstallPrompt` and
 * announces it with `tt:install-available`; this hook reads what is already there on mount AND
 * subscribes, so it cannot lose the race either way.
 *
 * ── ONE TAP IS POSSIBLE ON ANDROID AND NOT ON iPHONE ─────────────────────────
 * Chrome, Edge and every Android browser expose `prompt()`, so the button installs directly.
 *
 * Safari exposes NOTHING. There is no API on iOS by which a web page can install itself, or
 * even ask to; installation is Share → Add to Home Screen, performed by the person holding the
 * phone. This is Apple's restriction and no amount of code gets around it — so the honest
 * design is a button that opens a picture of exactly where to tap, rather than a button that
 * appears to install and silently does nothing.
 */
import { useCallback, useEffect, useState } from "react";

/** The slice of `BeforeInstallPromptEvent` actually used. It is not in the DOM lib types. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    /** Stashed by the inline script in `index.html`; see the header. */
    __ttInstallPrompt?: InstallPromptEvent | null;
  }
}

export type InstallMode =
  /** One tap installs it. The browser gave us a real prompt to replay. */
  | "prompt"
  /** iOS and anything else with no install API: the button shows where to tap instead. */
  | "guide"
  /** Running as an installed app already — there is nothing left to offer. */
  | "unavailable";

export interface InstallApp {
  readonly mode: InstallMode;
  readonly isStandalone: boolean;
  readonly isIos: boolean;
  /** Resolves true when the user accepted. Only meaningful when `mode === "prompt"`. */
  readonly install: () => Promise<boolean>;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
  // iOS Safari's own flag, non-standard and the only one it sets.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * iOS, INCLUDING iPadOS, which lies about itself. Since iPadOS 13 an iPad reports "Macintosh"
 * in the user agent, so the platform check is paired with touch support — a real Mac reports no
 * touch points.
 */
function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

export function useInstallApp(): InstallApp {
  // Seeded from whatever the head script already caught, which is the whole point of it.
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(
    () => (typeof window === "undefined" ? null : (window.__ttInstallPrompt ?? null)),
  );
  const [isStandalone, setIsStandalone] = useState<boolean>(detectStandalone);
  const isIos = detectIos();

  useEffect(() => {
    function onAvailable(): void {
      setPromptEvent(window.__ttInstallPrompt ?? null);
    }
    function onInstalled(): void {
      setPromptEvent(null);
      setIsStandalone(true);
    }

    /*
      THE THIRD CASE, which the seed and the listener between them still miss: the event landing
      AFTER the first render but BEFORE this effect runs. Narrow, but real — the head script
      catches it either way, so re-reading the stash here closes the gap. Verified: without this
      line the button rendered but fell through to the manual guide instead of installing,
      because the hook's state was still null while `window.__ttInstallPrompt` held the event.
    */
    if (window.__ttInstallPrompt) setPromptEvent(window.__ttInstallPrompt);

    // Both the head script's relay and the native events: the relay covers an event that fired
    // before this mounted, the native listener covers one that fires after.
    window.addEventListener("tt:install-available", onAvailable);
    window.addEventListener("beforeinstallprompt", onAvailable);
    window.addEventListener("tt:installed", onInstalled);
    window.addEventListener("appinstalled", onInstalled);

    // Launching the installed app from the home screen does not reload this module, so the
    // display mode is watched rather than only read once.
    const media = window.matchMedia("(display-mode: standalone)");
    const onDisplayChange = (event: MediaQueryListEvent): void => {
      if (event.matches) setIsStandalone(true);
    };
    media.addEventListener("change", onDisplayChange);

    return () => {
      window.removeEventListener("tt:install-available", onAvailable);
      window.removeEventListener("beforeinstallprompt", onAvailable);
      window.removeEventListener("tt:installed", onInstalled);
      window.removeEventListener("appinstalled", onInstalled);
      media.removeEventListener("change", onDisplayChange);
    };
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    const event = promptEvent ?? window.__ttInstallPrompt ?? null;
    if (event === null) return false;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // Single-use: the browser refuses a second `prompt()` on the same event.
    window.__ttInstallPrompt = null;
    setPromptEvent(null);
    return outcome === "accepted";
  }, [promptEvent]);

  const mode: InstallMode = isStandalone
    ? "unavailable"
    : promptEvent !== null
      ? "prompt"
      : "guide";

  return { mode, isStandalone, isIos, install };
}
