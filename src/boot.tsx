/**
 * boot.tsx — mounting React, moved out of `main.tsx`.
 *
 * The split exists so `main.tsx` can check the environment BEFORE this module is
 * imported. Everything here transitively reaches `src/lib/env.ts`, which throws at
 * module scope when a `VITE_` variable is missing — and a throw during module
 * evaluation renders nothing at all, with no error boundary able to catch it. That
 * is what produced a blank page on the first Vercel deploy.
 *
 * `main.tsx` imports this DYNAMICALLY, so the import chain is only evaluated once the
 * variables are known to be present.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import AppRoutes from "@/app/routes";
import { registerServiceWorker } from "@/shared/pwa/registerServiceWorker";

export function mount(rootEl: HTMLElement): void {
  /*
    Registered here rather than inside `AppShell`, which only mounts for a signed-in user. The
    install offer depends on a registered worker, and the people most likely to want the app on
    their phone meet the LOGIN screen first — so a shell-only registration meant Chrome never
    offered to install it to them. Deliberately not awaited: the app must render whether or not
    the worker registers.
  */
  void registerServiceWorker();

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <AppProviders>
          <AppRoutes />
        </AppProviders>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
