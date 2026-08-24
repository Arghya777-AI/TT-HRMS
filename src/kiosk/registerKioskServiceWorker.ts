/**
 * Register the gate's own service worker.
 *
 * Scoped to `/kiosk/`, which is what keeps the two installed apps genuinely separate: the HR
 * app's worker at `/` controls its own pages, this one controls the gate, and neither can
 * take over the other's clients or evict the other's caches.
 *
 * ── WHY IT DOES NOT ASK THE USER ANYTHING ────────────────────────────────────
 * The HR app's registration deliberately waits for the page to say when to activate a new
 * worker, because swapping the bundle under a half-filled leave form loses somebody's work.
 * A gate has no forms and no half-finished state: the worst an immediate takeover costs is
 * one re-scan. So this one claims clients and skips waiting, because a wall-mounted terminal
 * that nobody visits for a month should not still be running the bundle from a month ago,
 * and there is no human standing at it to click "reload".
 */

/** Where the built worker lands. Its scope is implied by its path. */
const KIOSK_SW_URL = "/kiosk/kiosk-sw.js";

export function registerKioskServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register(KIOSK_SW_URL, { scope: "/kiosk/" })
      .then((registration) => {
        /*
          Check for a new build whenever the terminal is woken up.

          A gate is opened once and then left alone for weeks. Without this it would only
          ever pick up a deploy on a hard reload that nobody performs, and the fix that was
          shipped for the gate would sit on the server unused.
        */
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update();
        });
      })
      .catch(() => {
        /*
          A failed registration must not stop the gate.

          The worker is what makes it work OFFLINE; the gate still works online without it.
          Throwing here would turn "no offline capability" into "no attendance at all",
          which is the wrong trade at an entrance.
        */
      });
  });
}
