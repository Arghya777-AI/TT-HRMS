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
         * NO MANUAL VENDOR SPLITTING. This is deliberate, and it is a fix.
         *
         * WHAT THE OLD SPLIT DID
         * ---------------------
         * It routed `react`, `react-dom`, `react-router` and `scheduler` into
         * `chunk-react`, the specialised libraries into `chunk-ui` / `chunk-query` /
         * `chunk-supabase` / `chunk-charts`, and EVERYTHING else in node_modules into
         * `chunk-vendor`. It looked tidy and it broke the app in the browser:
         *
         *     Uncaught (in promise) TypeError:
         *     Cannot read properties of undefined (reading 'createContext')
         *       at chunk-vendor-*.js
         *
         * Dozens of small packages read `React.createContext` while their module body
         * evaluates. Hand-assigning them to a different chunk from React creates a
         * cross-chunk cycle, and when the cycle is entered from the wrong side React
         * is still an uninitialised binding — so `React` is `undefined` and the app
         * dies before it renders a single element. Nothing is caught, because it
         * happens during module evaluation: no error boundary, no message, a blank
         * page on every browser.
         *
         * WHY IT WAS NOT CAUGHT EARLIER, which is the more useful lesson
         * ------------------------------------------------------------
         * `manualChunks` only applies to `vite build`. Dev serves unbundled ES
         * modules, so months of `npm run dev` could never surface it. `npm run build`
         * exited 0 the whole time — a build succeeding says nothing about whether the
         * bundle it produced can be evaluated. The first person ever to OPEN a
         * production build in a browser was the client, on the deployed URL.
         *
         * WHY REMOVAL IS THE RIGHT FIX RATHER THAN A CLEVERER SPLIT
         * --------------------------------------------------------
         * Rollup already computes a correct chunk graph from the real import graph,
         * including evaluation order across cycles. Hand-written `manualChunks` opts
         * out of exactly that guarantee, and every "fix" that keeps hand-assignment
         * is one dependency upgrade away from reintroducing this. The caching benefit
         * it was reaching for is small next to a bundle that cannot start.
         *
         * WHAT IS PRESERVED: `@vladmandic/face-api` (~1.3 MB) still lands in its own
         * chunk and still never appears in the entry graph — not because it is named
         * here, but because every consumer reaches it through a DYNAMIC import
         * (`loadFaceModels` in features/kiosk/lib/facePipeline.ts). Rollup emits a
         * separate chunk for a dynamic import automatically, so architecture D-07 is
         * satisfied by the import style rather than by configuration that can drift.
         * `src/features/kiosk/bundleBudget.test.ts` asserts that, so the guarantee is
         * measured rather than assumed.
         */
      },
    },
  },
});
