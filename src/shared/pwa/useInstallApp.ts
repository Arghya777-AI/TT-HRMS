/**
 * useInstallApp — is this app installable on this device, and how.
 *
 * THERE ARE TWO WORLDS AND THEY WORK NOTHING ALIKE.
 *
 * On Chrome, Edge and Android browsers the browser fires `beforeinstallprompt` once it decides
 * the app qualifies (manifest, icons, a service worker with a fetch handler, served over HTTPS).
 * The event must be kept and replayed on a user gesture — calling `prompt()` outside one is
 * refused — so it is stashed here and the button calls it.
 *
 * On iOS Safari that event does not exist and never will. Installation is Share → Add to Home
 * Screen, done by the user, and no API can trigger or detect the intent. The only honest thing
 * a button can do there is SHOW THE INSTRUCTIONS, which is why `mode` distinguishes `"prompt"`
 * from `"instructions"` rather than pretending one button works everywhere.
 *
 * ALREADY INSTALLED IS A THIRD STATE, and it matters: offering "Install app" inside the
 * installed app is the kind of detail that makes software feel unmaintained. It is detected two
 * ways because the platforms disagree — `display-mode: standalone` (the standard) and
 * `navigator.standalone` (iOS's own, non-standard, still the only signal there).
 */
import { useCallback, useEffect, useState } from "react";

/** The slice of `BeforeInstallPromptEvent` actually used. It is not in the DOM lib types. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallMode =
  /** The browser offered a real prompt; the button can install directly. */
  | "prompt"
  /**
   * No prompt available, so the card explains how to do it by hand.
   *
   * This is the DEFAULT rather than a rare iOS case, and that is deliberate.
   * `beforeinstallprompt` fires only once Chrome's own criteria are met, and it may not have
   * fired yet on this visit — so keying the whole card on it meant an employee on Android could
   * open the menu looking for the app and find nothing at all. Instructions always work.
   */
  | "instructions"
  /** Running as an installed app already — there is nothing left to offer. */
  | "unavailable";

export interface InstallApp {
  readonly mode: InstallMode;
  readonly isStandalone: boolean;
  readonly isIos: boolean;
  /** Resolves to true when the user accepted. Only meaningful when `mode === "prompt"`. */
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
 * in the user agent, so the platform check has to be paired with touch support — a real Mac has
 * no touch points.
 */
function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

export function useInstallApp(): InstallApp {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(detectStandalone);
  const isIos = detectIos();

  useEffect(() => {
    function onBeforeInstallPrompt(event: Event): void {
      // Without this the browser shows its own mini-infobar and ours would be a second,
      // competing offer of the same thing.
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    }
    function onInstalled(): void {
      setPromptEvent(null);
      setIsStandalone(true);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // Launching the installed app from the home screen does not reload this module, so the
    // display mode is watched rather than only read once.
    const media = window.matchMedia("(display-mode: standalone)");
    const onDisplayChange = (event: MediaQueryListEvent): void => {
      if (event.matches) setIsStandalone(true);
    };
    media.addEventListener("change", onDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      media.removeEventListener("change", onDisplayChange);
    };
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    if (promptEvent === null) return false;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    // The event is single-use: the browser refuses a second `prompt()` on the same one.
    setPromptEvent(null);
    return outcome === "accepted";
  }, [promptEvent]);

  const mode: InstallMode = isStandalone
    ? "unavailable"
    : promptEvent !== null
      ? "prompt"
      : "instructions";

  return { mode, isStandalone, isIos, install };
}
