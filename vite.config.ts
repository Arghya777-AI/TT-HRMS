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
    /**
     * SAFARI 12, BECAUSE THE GATE TABLET IS AN iPAD ON iOS 12.5.7.
     *
     * iOS 12.5.7 is the terminal release for the iPad Air 1, iPad mini 2/3 and iPhone 5s —
     * hardware that is perfectly good for a wall-mounted scanner and will never get another
     * major iOS. It ships Safari 12.1, which predates OPTIONAL CHAINING and NULLISH
     * COALESCING (both Safari 13.1).
     *
     * At `es2020` esbuild left those in, and the shipped gate bundle carried 52 `?.` and 85
     * `??`. A module that fails to PARSE runs nothing at all, so the terminal was a black
     * screen with no error — there is no runtime yet in which an error could be thrown. That
     * is the whole of why the link "did not open in Safari".
     *
     * Set for the WHOLE build, not just the gate entry: Vite resolves one target per build,
     * and the gate shares its React and vendor chunks with the HR app. Transpiling those
     * twice is not an option, and lowering them costs a few KB of gzip against a terminal
     * that otherwise cannot run.
     *
     * Syntax is all this fixes. Runtime APIs that Safari 12 lacks are polyfilled in
     * `kiosk/index.html` before the module loads — esbuild lowers syntax and never adds a
     * polyfill.
     */
    target: "safari12",
    rollupOptions: {
      /**
       * TWO APPS, ONE REPOSITORY.
       *
       * `index.html` is the HR product. `kiosk/index.html` is the gate terminal — a
       * separate installed app with its own manifest, its own service-worker scope
       * (`/kiosk`) and its own icon on the tablet at the entrance. Installing the HR app
       * on a wall-mounted screen would give you an icon that opens somebody's payslips.
       *
       * They share this repository because they share the code that matters: the face
       * pipeline, the device pairing and the types are the same files, so a change to the
       * descriptor contract cannot land in one and miss the other. What they do not share
       * is the bundle — the gate carries no router, no query client, no auth provider and
       * no app shell, which is the whole reason this is an entry point rather than a route.
       */
      /*
       * The KEY becomes the emitted entry's filename. `index` is deliberate, not
       * cosmetic: naming it `main` renamed the HR app's entry chunk from `index-*.js` to
       * `main-*.js`, which is a change to the existing app's output for no reason —
       * it invalidates every cached copy and it broke
       * `features/kiosk/bundleBudget.test.ts`, which asserts the entry's name. Adding a
       * second app should leave the first one's build byte-for-byte alone.
       */
      input: {
        index: path.resolve(__dirname, "index.html"),
        kiosk: path.resolve(__dirname, "kiosk/index.html"),
        /*
          The self-test page. A third entry rather than a static file, because it deliberately
          imports the REAL `facePipeline` — the same `loadFaceModels` and `readFrame` the gate
          calls. A hand-written copy would report on itself instead of on the gate, which is
          worse than no test: it would pass on a device that cannot actually recognise anyone.
        */
        check: path.resolve(__dirname, "check/index.html"),
      },
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
