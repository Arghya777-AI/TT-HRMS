/**
 * Register the gate's own service worker.
 *
 * Scoped to `/kiosk`, which is what keeps the two installed apps genuinely separate: the HR
 * app's worker at `/` controls its own pages, this one controls the gate, and neither can
 * take over the other's clients or evict the other's caches.
 *
 * ── WHY THE SCOPE HAS NO TRAILING SLASH, AND WHY IT MATTERS ──────────────────
 * It used to be `/kiosk/`, and that is a real bug rather than a cosmetic one. A scope is a
 * URL PREFIX, so `/kiosk/` does not contain `/kiosk` — and `/kiosk` is exactly the address
 * the gate is opened at. The worker therefore registered successfully, reported no error,
 * and controlled NOTHING. Two consequences followed:
 *
 *   1. NO INSTALL PROMPT. Chrome and Edge only offer "Install app" when a service worker
 *      controls the manifest's `start_url`. `/kiosk?source=pwa` sat outside `/kiosk/`, so
 *      the tablet showed no install option at all — the manifest and icons were served
 *      perfectly and the browser still had no reason to believe the page was installable.
 *   2. NO OFFLINE. The precached shell was never consulted, because the fetch handler was
 *      never invoked for the page.
 *
 * A script at `/kiosk/kiosk-sw.js` may normally only claim `/kiosk/` or deeper; claiming the
 * shorter `/kiosk` requires the server to say so, which `vercel.json` does with
 * `Service-Worker-Allowed: /kiosk` on the worker's own response. Both halves are required
 * and neither is optional.
 *
 * The prefix also matches a hypothetical `/kiosk-something`. Nothing of the sort is routed,
 * and the alternative — canonicalising the gate to `/kiosk/` — would change the address the
 * client asked for.
 *
 * ── WHY IT DOES NOT ASK THE USER ANYTHING ────────────────────────────────────
 * The HR app's registration deliberately waits for the page to say when to activate a new
 * worker, because swapping the bundle under a half-filled leave form loses somebody's work.
 * A gate has no forms and no half-finished state: the worst an immediate takeover costs is
 * one re-scan. So this one claims clients and skips waiting, because a wall-mounted terminal
 * that nobody visits for a month should not still be running the bundle from a month ago,
 * and there is no human standing at it to click "reload".
 */

/** Where the built worker lands. Its scope is WIDER than its path — see the header. */
const KIOSK_SW_URL = "/kiosk/kiosk-sw.js";

export function registerKioskServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    /*
      RETIRE THE OLD `/kiosk/` REGISTRATION FIRST.

      Changing the scope does not move the existing worker — it creates a SECOND
      registration and leaves the old one resident. Every tablet already opened before this
      deploy is carrying the `/kiosk/`-scoped worker, which controls nothing and would sit
      there indefinitely holding its v1 caches. Registering the new scope is not enough on
      its own; the dead one has to be asked to leave.

      Failures are ignored on purpose: an unremovable stale registration is untidy, not
      broken, and must not stop the new one from being installed.
    */
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter((r) => new URL(r.scope).pathname === "/kiosk/")
            .map((r) => r.unregister().catch(() => false)),
        ),
      )
      .catch(() => undefined);

    void navigator.serviceWorker
      .register(KIOSK_SW_URL, { scope: "/kiosk" })
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
