/**
 * The gate app's entry point — a separate installed app from the HR product.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY EACH ABSENCE IS THE POINT
 * =============================================================
 * `src/main.tsx` mounts a router, a query client, an auth provider, a toast host and the
 * app shell. None of that is here:
 *
 *   NO ROUTER          The gate has one screen. Its only outbound link crosses to the HR
 *                      app as a full document navigation, which is what moving between two
 *                      installed apps actually is.
 *   NO QUERY CLIENT    The gate reads nothing through the API layer. It talks to three
 *                      edge functions with the device HMAC and holds its own state.
 *   NO AUTH PROVIDER   There is no user session here — ever. The device is the principal,
 *                      and an unattended gate has no operator either. A Supabase auth
 *                      client on a wall-mounted tablet is a token nobody needs.
 *   NO APP SHELL       No nav, no sidebar, no HR data on screen. A queue can read this
 *                      screen from two metres away; anything else on it is a leak.
 *
 * The result is a bundle that carries the camera, the face pipeline and this file — which
 * is the whole reason for a second entry rather than a route.
 *
 * THE ENGINE IS STILL DYNAMICALLY IMPORTED. `loadFaceModels` in
 * `features/kiosk/lib/facePipeline.ts` reaches `@vladmandic/face-api` through a dynamic
 * import, so the ~1.3 MB engine stays out of this entry graph exactly as it stays out of
 * the HR app's. `features/kiosk/bundleBudget.test.ts` measures that, and it must keep
 * measuring it for this entry too.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import KioskPage from "@/features/kiosk/pages/Kiosk.page";
import "@/index.css";
import { registerKioskServiceWorker } from "./registerKioskServiceWorker";

const container = document.getElementById("kiosk-root");
if (container === null) {
  // Loud, not silent: a gate that renders nothing looks identical to a gate that is
  // working but has no one in front of it, and somebody would stand there scanning.
  throw new Error("kiosk/index.html is missing #kiosk-root — the terminal cannot start.");
}

createRoot(container).render(
  <StrictMode>
    <KioskPage />
  </StrictMode>,
);

/*
 * Registered after the first render, never before.
 *
 * The models are ~6.4 MB and the worker will want to cache them. Doing that while the
 * first paint is still pending competes with the bundle the screen needs in order to show
 * anything at all, on the slowest device in the estate.
 */
registerKioskServiceWorker();
