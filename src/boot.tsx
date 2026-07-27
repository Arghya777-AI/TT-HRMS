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

export function mount(rootEl: HTMLElement): void {
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
