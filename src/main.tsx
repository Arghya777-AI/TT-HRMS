import React from "react";
import ReactDOM from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import AppRoutes from "@/app/routes";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </ErrorBoundary>
  </React.StrictMode>,
);
