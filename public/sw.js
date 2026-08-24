/*
  Service worker for the Tamarind Tree HRMS installable app.

  ── WHAT THIS DELIBERATELY DOES NOT CACHE ────────────────────────────────────
  Nothing from the API. Not one response. This is a payroll and attendance system: a cached
  leave balance, a cached punch list or a stale approval queue is not a degraded experience, it
  is wrong information presented as current, and somebody makes a decision on it. Every request
  that is not a same-origin static asset goes to the network and is allowed to fail, so an
  offline screen shows its own error state rather than yesterday's numbers.

  That means requests to Supabase (REST, Realtime, Storage, Auth), every `/functions/v1/` edge
  function call, and anything carrying an Authorization header are network-only. Tokens are
  never written to a cache.

  ── WHAT IT DOES CACHE, AND WHY THAT IS SAFE ─────────────────────────────────
  1. Vite's content-hashed bundles under `/assets/`. The hash IS the version, so a cache hit can
     never be stale — a changed file has a different URL. Cache-first, which is what makes the
     installed app open instantly.
  2. The app shell (`/index.html`) and static images, NETWORK-FIRST. Network-first, not
     cache-first, because the shell is the one unhashed file: serving it from cache would pin
     users to whichever deploy they first installed. The cached copy is the offline fallback
     only.
  3. Google's font files (immutable, hashed URLs) so the installed app is not unstyled offline.

  ── UPDATES ──────────────────────────────────────────────────────────────────
  No `skipWaiting()` on install. A new worker waits, and the page decides when to activate it
  by posting `{type:"SKIP_WAITING"}` — see `useServiceWorker`. Taking over mid-session would
  swap the bundle under a half-filled leave form.
*/

const VERSION = "v1";
const ASSET_CACHE = `tt-assets-${VERSION}`;
/*
  The face-recognition weights, in their OWN bucket.

  Separate from `tt-assets` on purpose: it is ~6.4 MB, only the gate needs it, and keeping it
  apart means a future eviction or a deliberate purge can drop the models without also
  throwing away the app bundle the rest of the product boots from.
*/
const MODEL_CACHE = `tt-models-${VERSION}`;
const SHELL_CACHE = `tt-shell-${VERSION}`;
const SHELL_URL = "/index.html";

/** Hosts whose responses may be cached. Everything else is network-only, by omission. */
const FONT_HOSTS = new Set(["fonts.gstatic.com", "fonts.googleapis.com"]);

self.addEventListener("install", (event) => {
  // Only the shell is pre-fetched. The hashed bundles arrive on first use, which avoids
  // guessing their names at build time and avoids a precache manifest going stale.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: "reload" })))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.endsWith(VERSION)).map((key) => caches.delete(key)),
      );
      // Navigation preload lets the browser start the network request in parallel with the
      // worker booting, so the shell is not delayed by our own startup.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => undefined);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

/** True for the content-hashed build output, which is safe to serve from cache forever. */
function isHashedAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/assets/");
}

/** Same-origin static files we are willing to keep an offline copy of. */
function isStaticFile(url) {
  return (
    url.origin === self.location.origin &&
    /\.(?:png|jpe?g|svg|webp|ico|woff2?|json|webmanifest)$/i.test(url.pathname) &&
    // Models are handled by `isFaceModel` into their own bucket — see below.
    !url.pathname.startsWith("/models/")
  );
}

/*
  The face-recognition weights under `/models/`.

  THIS USED TO BE AN EXCLUSION, AND THAT WAS RIGHT UNTIL THE GATE EXISTED. The reasoning was
  "tens of megabytes and only the kiosk needs them", which is a good argument for keeping them
  off an employee's phone and a fatal one for a wall-mounted terminal: a gate that reloads
  during an internet outage — a browser refresh, an OS tab eviction, a power cut — would come
  back unable to recognise anybody at all, which is precisely the moment it has to work.

  Cache-first and never revalidated, which is safe for one specific reason: these files are
  immutable weights, and the descriptor they produce must stay byte-identical to the one
  enrolment produced or every stored template becomes uncomparable. A silently updated model is
  not a fresher model, it is a broken match. A new model ships as a new path.
*/
function isFaceModel(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/models/");
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque (`type: "opaque"`) responses are cacheable and are what cross-origin font files
  // return; only a real error is worth not storing.
  if (response && (response.ok || response.type === "opaque")) {
    void cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) void cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (fallbackUrl) {
      const shell = await cache.match(fallbackUrl);
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is ever served from a cache. A POST/PATCH is a write and must reach the server.
  if (request.method !== "GET") return;

  // An authenticated request is never cached, whatever its URL looks like.
  if (request.headers.has("Authorization")) return;

  const url = new URL(request.url);

  /*
    THE iOS CONFIGURATION PROFILE IS NEVER TOUCHED. Tapping its link is a NAVIGATION, so without
    this guard the handler below would run: it would cache the profile under the shell cache and
    could later hand a `.mobileconfig` back for a page navigation. It must also reach Safari with
    the exact headers the server set — `application/x-apple-aspen-config` is what makes iOS treat
    it as installable — and a cached copy replayed by a worker is not worth the risk.
  */
  if (url.pathname.endsWith(".mobileconfig")) return;

  // Navigations: network-first so a deploy is picked up, cached shell as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        /*
          `preloadResponse` REJECTS when the network is unreachable — it does not resolve
          undefined. Awaiting it bare therefore threw straight out of this handler, `respondWith`
          rejected, and the browser showed its own "site can't be reached" page instead of the
          cached shell. Caught here, verified offline: the app now renders and shows its own
          error states, which is the whole point of the shell being cached.
        */
        const preloaded = await event.preloadResponse.catch(() => undefined);
        if (preloaded) {
          const cache = await caches.open(SHELL_CACHE);
          void cache.put(SHELL_URL, preloaded.clone());
          return preloaded;
        }
        try {
          return await networkFirst(request, SHELL_CACHE, SHELL_URL);
        } catch {
          // Last resort: the shell from either cache, so an offline launch of the installed app
          // is never a browser error page.
          const shell =
            (await caches.match(SHELL_URL)) ?? (await caches.match(new Request("/")));
          if (shell) return shell;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  /*
    The recognition weights. Cache-first, so the gate survives a reload with no network.

    Placed ahead of the static-file rule because that rule deliberately excludes `/models/`;
    without this branch the models would fall through to the network untouched and the gate
    would be blind offline.
  */
  if (isFaceModel(url)) {
    event.respondWith(cacheFirst(request, MODEL_CACHE));
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (isStaticFile(url)) {
    event.respondWith(networkFirst(request, ASSET_CACHE));
    return;
  }

  // Everything else — the API, edge functions, Realtime, Storage — falls through to the
  // network untouched. No `respondWith`, no cache, no interception.
});
