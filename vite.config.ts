import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Env is read from .env.local at build/dev time. We NEVER inline a fallback
// key here (the reference repo hard-coded an anon JWT in this file — a defect
// we do not repeat). Only VITE_-prefixed vars reach the client bundle.
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    sourcemap: true,
    target: "es2020",
    rollupOptions: {
      output: {
        /**
         * Vendor splitting keeps the entry chunk small and lets the browser
         * cache libraries across deploys. `chunk-face` is reserved for
         * @vladmandic/face-api: it must NEVER appear in the entry graph
         * (architecture D-07) — only the kiosk and enrolment routes
         * dynamic-import it.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@vladmandic/face-api")) return "chunk-face";
          if (id.includes("recharts") || id.includes("d3-")) return "chunk-charts";
          if (id.includes("@supabase")) return "chunk-supabase";
          if (id.includes("@tanstack")) return "chunk-query";
          if (id.includes("@radix-ui") || id.includes("cmdk") || id.includes("sonner")) return "chunk-ui";
          if (id.includes("jspdf")) return "chunk-pdf";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("react-router") ||
            id.includes("scheduler")
          ) {
            return "chunk-react";
          }
          return "chunk-vendor";
        },
      },
    },
  },
});
