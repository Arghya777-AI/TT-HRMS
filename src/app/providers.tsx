/**
 * providers.tsx — the single provider stack. Order matters:
 * Theme (paints) → Query (server state) → Router (URL) → Auth (needs Query+URL)
 * → Toaster (portal, must sit inside Theme for tokens).
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "./auth/AuthProvider";

/**
 * Query defaults (frontend-contract §5): server state is authoritative and
 * cheap to refetch on navigation, but we never hammer on window focus.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem storageKey="tt-hrms-theme">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            {children}
            <Toaster />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
