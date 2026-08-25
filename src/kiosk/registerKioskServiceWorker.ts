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

/**
 * Reload once a new worker has taken over.
 *
 * ── WHY THE PAGE HAS TO BE TOLD ──────────────────────────────────────────────
 * `clients.claim()` puts the new worker in charge of this page, but the page is still RUNNING
 * the bundle it booted with. In a browser tab the next navigation fixes that. An installed PWA
 * never navigates again — it is opened once and resumed from a frozen state for weeks — so
 * without this it would hold the old build indefinitely. That is exactly what was reported: the
 * server updated, the device did not.
 *
 * Guarded twice. `reloading` stops a double reload when both the message and `controllerchange`
 * arrive, which they normally both do. And a gate mid-punch is left alone until it is not: a
 * reload during a scan would be one lost re-scan, which is small but avoidable.
 */
function reloadWhenReplaced(): void {
  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    /*
      `data-tt-gate-busy` is set by the scan screen while a punch is in flight. Waiting for it
      to clear costs a second at most and means no reload ever lands between a face and its
      record.
    */
    const waitForIdle = () => {
      if (document.body.dataset["ttGateBusy"] === "true") {
        window.setTimeout(waitForIdle, 500);
        return;
      }
      window.location.reload();
    };
    waitForIdle();
  };

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data !== null && data.type === "tt-gate-updated") reload();
  });

  /*
    The belt to the message's braces. `controllerchange` fires when a new worker takes control,
    including in cases where the message never arrives — a worker activated while no client was
    listening, for instance. Only after the first controller exists: on a brand-new install the
    controller arrives for the first time and reloading then would be a pointless bounce.
  */
  if (navigator.serviceWorker.controller !== null) {
    navigator.serviceWorker.addEventListener("controllerchange", reload);
  }
}

export function registerKioskServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  reloadWhenReplaced();

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

        /*
          ── AND ASK ON A TIMER, BECAUSE A WALL TERMINAL IS NEVER "WOKEN" ──────────
          `visibilitychange` covers a tablet somebody picks up. It does not cover the gate this
          product is actually for: mounted, never touched, never backgrounded, running the same
          page for weeks. Nothing there ever triggers an update check, so a deploy would sit on
          the server indefinitely while the terminal ran whatever it booted with.

          Half an hour. An update check is one conditional GET of a ~6 KB script — cheap enough
          to be routine, and far more often than anybody would reload it by hand.
        */
        window.setInterval(() => void registration.update(), 30 * 60 * 1000);
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
