# Deploying this app

`vercel.json` cannot hold comments, so the reasoning behind every line of it lives
here. Each entry exists because of an observed failure, not a convention.

## The blank page

The first deploy to `tt-hrms.vercel.app` served a correct `index.html`, a 892 KB
bundle at HTTP 200, and a completely empty `#root`.

Cause: `src/lib/env.ts` builds its `env` object at module scope and throws from
`required()` when a `VITE_` variable is missing. That throw happens during **module
evaluation**, before any React code runs, so `ErrorBoundary` cannot catch it — a React
error boundary catches errors thrown while rendering, and nothing had begun to render.

Fix: `src/main.tsx` now checks `lib/env-check.ts` (a module with no imports, which
cannot throw) and only imports `src/boot.tsx` once the variables are present.
Otherwise it renders a diagnostic naming the missing variables.

**The thing that catches everyone:** Vite *inlines* `import.meta.env.VITE_*` at build
time. A variable added in the hosting dashboard changes nothing until the app is
**rebuilt** — the old value, or `undefined`, is already compiled into the JavaScript
being served. The on-screen diagnostic says so explicitly.

### Required at build time

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key — **never** a `sb_secret_…` one |

`VITE_APP_NAME` and `VITE_APP_TIMEZONE` have defaults and are optional. Anything
prefixed `VITE_` is compiled into the browser bundle and is therefore public: a
service-role key must never appear in one.

## `rewrites` — why a single catch-all is correct

```json
{ "source": "/(.*)", "destination": "/index.html" }
```

The router owns 188 client-side paths, including the standalone `/kiosk`. Without a
rewrite, only `/` works: `/kiosk`, `/login` and every deep link 404 on direct
navigation or refresh, because no file exists at those paths. The kiosk link is the
whole reason for deploying, and it is always opened as a direct URL.

A catch-all looks like it would also swallow `/models/face_recognition_model.bin` and
return HTML for it — which would break face recognition silently while the rest of the
app looked healthy. It does not: **Vercel checks the filesystem before applying
rewrites**, so real files win. This is verified after each deploy by fetching a
`.bin` and asserting the content-type is not `text/html`.

## `Permissions-Policy` — the gate needs a camera

```
camera=(self), geolocation=(self), microphone=()
```

`/kiosk` calls `getUserMedia` for the face scan and `navigator.geolocation` to stamp
where a punch happened. Both are permission-gated features that a restrictive default
policy would block outright. `microphone=()` is denied because nothing in this product
records audio, and an unused capability should not be available to be exploited.

Both APIs additionally require a **secure context**. HTTPS satisfies that, which is
the real reason the kiosk had to be hosted rather than served from `http://<LAN-IP>`:
on plain HTTP over a LAN address the camera and geolocation are unavailable, the screen
looks fine, and it simply never sees a face.

## `Cache-Control` on `/models` and `/assets`

The face weights are 6.4 MB and their filenames are fixed, so they are marked
`immutable` for a year — a guard's phone should download them once, not per shift.
`/assets` filenames are content-hashed by Vite, so the same applies with no risk of
serving a stale bundle: a new build produces new names.

`X-Content-Type-Options: nosniff` and `Referrer-Policy` are ordinary hardening.
`X-Frame-Options` is deliberately **not** set here — it would break nothing today, but
the kiosk is a candidate for embedding in a venue dashboard later and a header added
now for no measured reason is the kind of thing that costs an afternoon then.

## Also required, and NOT in this file

These are dashboard settings that no repo change can cover:

1. **Supabase → Edge Functions → CORS.** `supabase/functions/_shared/cors.ts` holds an
   exact-match origin allowlist. A new host must be added there and the functions
   redeployed, or every call fails at the browser's preflight. A `*.vercel.app`
   wildcard is deliberately refused — it would let any Vercel tenant's page drive
   these functions.
2. **Supabase → Authentication → URL Configuration.** Site URL and Additional Redirect
   URLs must include the deployed origin, or password-reset and magic-link emails
   point at the wrong host.
