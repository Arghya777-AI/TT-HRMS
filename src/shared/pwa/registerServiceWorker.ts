/**
 * Service-worker registration and update reporting.
 *
 * ── REGISTRATION HAPPENS AT BOOT, NOT IN THE SHELL ───────────────────────────
 * `registerServiceWorker()` is called from `boot.tsx`, before and regardless of sign-in. It was
 * originally inside `AppShell`, which only mounts for an authenticated user — so a worker never
 * registered while somebody sat on the login screen, and Chrome therefore never offered to
 * install the app to the very people most likely to want it on their phone. Verified: with the
 * call in the shell, `getRegistration()` returned nothing on `/me` for a signed-out visitor.
 *
 * `useServiceWorker` only OBSERVES that registration, and renders the update notice.
 *
 * ── WHY THE UPDATE IS OFFERED, NOT APPLIED ───────────────────────────────────
 * A service worker that calls `skipWaiting()` on install swaps the JavaScript bundle underneath
 * a running page. On a marketing site that is invisible. Here somebody is three steps into a
 * leave application, or has a reason typed into an approval dialog, and the reload throws it
 * away. So the worker waits, this hook notices, and the user is told there is a new version and
 * chooses when to take it.
 *
 * ── WHY DEV IS EXCLUDED ──────────────────────────────────────────────────────
 * A worker intercepting requests in front of Vite's dev server serves yesterday's module graph
 * and produces bugs that do not exist in the code. It is registered only in a production build,
 * and any worker left over from one is actively unregistered in dev — otherwise a developer who
 * once ran a production build locally keeps a stale worker on `localhost` forever.
 */
import { useCallback, useEffect, useState } from "react";

export interface ServiceWorkerState {
  /** A new version is downloaded and waiting for permission to take over. */
  readonly updateReady: boolean;
  /** Activate the waiting worker and reload onto it. */
  readonly applyUpdate: () => void;
}

const SW_URL = "/sw.js";

/**
 * Register the worker. Call once, at boot, from any auth state.
 *
 * Returns the registration so callers may observe it; resolves to `null` when service workers
 * are unavailable, in development, or when registration failed — none of which is an error worth
 * surfacing, because without a worker this is simply a website.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;

  if (import.meta.env.DEV) {
    // Clear anything a previous production build left behind on this origin: a worker in front
    // of Vite's dev server serves yesterday's module graph and invents bugs.
    const existing = await navigator.serviceWorker.getRegistrations().catch(() => []);
    for (const registration of existing) void registration.unregister();
    return null;
  }

  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null;
  }
}

export function useServiceWorker(): ServiceWorkerState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (import.meta.env.DEV) return;

    let cancelled = false;

    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (cancelled || registration === undefined) return;

      // Already waiting when this mounted — the update arrived during a previous visit.
      if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
        setWaiting(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (installing === null) return;
        installing.addEventListener("statechange", () => {
          // `controller !== null` distinguishes an UPDATE from a first install. On a first
          // install there is nothing to reload onto and nothing to tell anybody about.
          if (installing.state === "installed" && navigator.serviceWorker.controller !== null) {
            setWaiting(installing);
          }
        });
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (waiting === null) return;
    // `controllerchange` fires once the waiting worker takes over; reloading then guarantees the
    // new page is served by the new worker rather than racing it.
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    waiting.postMessage({ type: "SKIP_WAITING" });
  }, [waiting]);

  return { updateReady: waiting !== null, applyUpdate };
}
