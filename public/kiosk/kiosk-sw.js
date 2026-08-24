/*
  Service worker for the TT Gate app — a separate installed app from the HR product.

  Scoped to `/kiosk/`. The HR app's worker at `/` is a different registration with different
  caches; neither controls the other's clients.

  ── WHAT THIS CACHES, AND WHY IT IS THE OPPOSITE DECISION FROM THE HR APP ────
  The HR app caches no API response, ever: a stale leave balance is wrong information that
  somebody acts on. That reasoning is unchanged and it still applies here — no punch result,
  no roster, no employee data is cached by this worker.

  But the HR app also refuses to cache the face models, on the grounds that they are ~6.4 MB
  and only the gate needs them. For the gate that refusal is fatal rather than frugal: a
  wall-mounted terminal that reloads during an internet outage — a browser refresh, an OS tab
  eviction, a power cut — would come back unable to recognise anybody, at exactly the moment
  it has to work. So this worker caches:

    1. The gate shell (`/gate/`) and its hashed bundles, so the app starts with no network.
    2. The recognition weights under `/models/`, cache-first and never revalidated.

  The models are immutable weights and that is why never revalidating them is safe, not
  merely convenient: the descriptor they produce must stay byte-identical to the one
  enrolment produced, or every stored template becomes uncomparable. A silently updated model
  is not a fresher model — it is a broken match. A new model ships as a new path.

  ── WHAT IT STILL REFUSES ────────────────────────────────────────────────────
  Every `/functions/v1/` call — pairing, punching, heartbeat — goes to the network and is
  allowed to fail, so the app sees a real failure and can queue rather than being handed a
  cached success. Nothing carrying an Authorization header or a device signature is stored.
*/

// Bumped to v2 with the scope fix: the v1 caches were keyed to a shell URL that was never
// navigated to, so they are stale by construction and the activate handler drops them.
const VERSION = "v2";
const SHELL_CACHE = `kiosk-shell-${VERSION}`;
const ASSET_CACHE = `kiosk-assets-${VERSION}`;
const MODEL_CACHE = `kiosk-models-${VERSION}`;
/*
  The shell is keyed at `/kiosk`, WITHOUT the trailing slash, because that is the URL the
  gate is actually opened at and the one the manifest names as `start_url`. Keying it at
  `/kiosk/` cached a document nobody ever navigated to, so the offline fallback missed.
*/
const SHELL_URL = "/kiosk";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Only the shell is precached. The hashed bundles are picked up on first use, which
      // avoids a precache manifest that goes stale on every deploy.
      await cache.add(new Request(SHELL_URL, { cache: "reload" })).catch(() => {});
      // A gate has no unsaved state to protect, so a new worker takes over at once.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("kiosk-") && !key.endsWith(VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isHashedAsset(url) {
  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith("/assets/") &&
    /-[A-Za-z0-9_-]{8,}\./.test(url.pathname)
  );
}

function isFaceModel(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/models/");
}

function isKioskDocument(request, url) {
  return (
    request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname.startsWith("/kiosk")
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque and error responses are not cached: storing a 404 for a model file would make
  // the gate permanently blind until the cache was cleared by hand.
  if (response.ok && response.type === "basic") await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // The shell. Network-first so a deploy reaches the terminal, cache as the offline
  // fallback — the shell is the one unhashed file, so serving it cache-first would pin the
  // gate to whichever build it was installed from.
  if (isKioskDocument(request, url)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(SHELL_URL, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(SHELL_URL);
          if (cached) return cached;
          return new Response("The gate app is not installed for offline use yet.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  if (isFaceModel(url)) {
    event.respondWith(cacheFirst(request, MODEL_CACHE));
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Everything else — every edge function, every signed request — goes to the network
  // untouched and is allowed to fail. See the header.
});
