/**
 * InstallGateApp — the "put this on the home screen" affordance for the gate terminal.
 *
 * ── WHY A BUTTON AT ALL, WHEN PWAs INSTALL THEMSELVES ────────────────────────
 * They do not, and the two big tablet platforms fail in opposite directions:
 *
 *   ANDROID / CHROME / EDGE fire `beforeinstallprompt` and show a small omnibox icon. On a
 *   tablet in kiosk orientation that icon is easy to miss entirely, and the event is only
 *   fired once per page load — miss it and there is no way back to it. Capturing the event
 *   and offering our own full-width button is the only reliable path.
 *
 *   iOS / iPadOS SAFARI never fires that event and has no install prompt of any kind. The
 *   ONLY way to install is Share → "Add to Home Screen", done by hand. A button that tries
 *   to call a prompt there would do nothing, so on Apple hardware this renders the
 *   instruction instead. Saying "not supported" would be wrong — it is supported, it is
 *   just manual.
 *
 * ── WHY IT HIDES ITSELF ──────────────────────────────────────────────────────
 * Once the gate is running as an installed app there is nothing to install, and a wall
 * terminal must not carry dead chrome. `display-mode` is the check rather than a stored
 * flag, because it is the truth: it reports how THIS window was opened.
 */
import { useEffect, useState } from "react";
import { Download, Share2, X } from "lucide-react";

/** The slice of the non-standard event this component uses. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Whether this window is already an installed app.
 *
 * Both queries are needed: the manifest asks for `fullscreen` and falls back to
 * `standalone` through `display_override`, so an installed gate can legitimately report
 * either. `navigator.standalone` is the iOS-only legacy signal and is checked last.
 */
function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches;
  const iosLegacy = (window.navigator as { standalone?: boolean }).standalone === true;
  return displayMode || iosLegacy;
}

/**
 * iOS and iPadOS, including the iPad that reports itself as a Mac.
 *
 * iPadOS 13+ sends a desktop-Safari user agent, so the platform string alone misses every
 * modern iPad. A Mac with a touchscreen does not exist, which makes `maxTouchPoints > 1` on
 * a "Macintosh" a reliable tell for an iPad in desktop mode.
 */
function isApplePortable(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** The event the entry's head script parked for us, if Chrome fired it before React ran. */
function parkedEvent(): InstallPromptEvent | null {
  if (typeof window === "undefined") return null;
  const parked = (window as unknown as { __ttInstallEvent?: InstallPromptEvent | null })
    .__ttInstallEvent;
  return parked ?? null;
}

export function InstallGateApp(): React.JSX.Element | null {
  const [installed, setInstalled] = useState(isInstalled);
  /*
    Seeded from the parked event, not from null.

    Chrome fires `beforeinstallprompt` once and early — routinely before this module has been
    parsed. Subscribing on mount and starting from null meant the event had already come and
    gone, `deferred` stayed null, and the bar returned null forever. On Android that presented
    as the install link simply not existing.
  */
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(parkedEvent);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  /*
    Set when Chrome has had a fair chance to offer the event and has not.

    That happens for real reasons — engagement heuristics, an origin already installed, a
    browser that does not support it — and in every one of them a person is still standing
    there wanting to install the app. Rendering nothing tells them nothing; after this flips,
    the bar shows Chrome's own menu path instead.
  */
  const [promptUnavailable, setPromptUnavailable] = useState(false);

  useEffect(() => {
    /*
      `preventDefault()` suppresses the browser's own mini-infobar so there is exactly one
      install affordance on screen — ours, which is sized for a tablet at arm's length.
      Keeping the event is what makes the button work later: `prompt()` can only be called
      on the instance the browser handed over.
    */
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    /*
      Three seconds is long enough for Chrome to have fired the event if it was going to —
      it does so as soon as the manifest and worker are validated, which has already happened
      by the time this page is interactive. After that, silence means it is not coming, and the
      honest thing is to show the manual route rather than nothing at all.
    */
    const id = window.setTimeout(() => setPromptUnavailable(true), 3_000);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;

  const apple = isApplePortable();
  /*
    Wait, but do not give up. While Chrome may still fire the event there is nothing useful to
    say, so stay hidden; once `promptUnavailable` flips, fall through and show the manual path.
    The old code returned null permanently in this branch, which is why an Android tablet that
    missed the event had no install affordance at all.
  */
  if (!apple && deferred === null && !promptUnavailable) return null;

  const install = async () => {
    if (deferred === null) return;
    setBusy(true);
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // One prompt per event, accepted or not. Dropping it prevents a second tap on a
      // spent event, which silently does nothing and reads as a broken button.
      setDeferred(null);
      if (outcome === "accepted") setInstalled(true);
    } catch {
      setDeferred(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    /*
      Fixed to the bottom rather than placed in the layout flow, deliberately. Each gate
      screen owns a full-viewport layout with its own footer, and threading a sibling bar
      through all three would mean touching three layouts for a bar that, by design, is
      never visible on the device that matters — an installed terminal returns null above.
    */
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="flex items-center gap-3">
        {apple ? (
          <p className="min-w-0 flex-1 text-xs leading-snug text-neutral-300">
            <span className="font-semibold text-neutral-100">Install this gate app:</span> tap{" "}
            <Share2 className="inline size-3.5 align-[-2px] text-sky-400" aria-label="Share" />{" "}
            Share, then <span className="font-semibold text-neutral-100">Add to Home Screen</span>.
            It then opens full screen with no address bar.
          </p>
        ) : deferred === null ? (
          /*
            Chrome never offered the prompt. Its own menu still installs, so name the path
            rather than leaving somebody hunting for a button that was never going to appear.
          */
          <p className="min-w-0 flex-1 text-xs leading-snug text-neutral-300">
            <span className="font-semibold text-neutral-100">Install this gate app:</span> open
            the browser menu <span className="font-semibold text-neutral-100">⋮</span> and choose{" "}
            <span className="font-semibold text-neutral-100">Install app</span> — or{" "}
            <span className="font-semibold text-neutral-100">Add to Home screen</span>. It then
            opens full screen and works without internet.
          </p>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-xs leading-snug text-neutral-300">
              <span className="font-semibold text-neutral-100">Install this gate app</span> so it
              opens full screen and works without internet.
            </p>
            <button
              type="button"
              onClick={() => void install()}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              <Download className="size-4" aria-hidden />
              {busy ? "Installing…" : "Install"}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide the install prompt"
          className="shrink-0 rounded-lg p-2 text-neutral-500 hover:text-neutral-300"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
