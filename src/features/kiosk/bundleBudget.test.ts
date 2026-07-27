/**
 * bundleBudget.test.ts — the production bundle must be startable, and the face
 * engine must stay out of the entry graph.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The deployed app was a blank page on every browser:
 *
 *     Uncaught (in promise) TypeError:
 *     Cannot read properties of undefined (reading 'createContext')
 *       at chunk-vendor-*.js
 *
 * `vite.config.ts` hand-assigned `react`/`react-dom` to `chunk-react` and every other
 * node_modules file to `chunk-vendor`. Dozens of small packages read
 * `React.createContext` while their module body evaluates, so splitting them away
 * from React created a cross-chunk cycle; entered from the wrong side, `React` was an
 * uninitialised binding and the app died during module evaluation — before React
 * mounted, so no error boundary could catch it and nothing rendered.
 *
 * THE LESSON THIS ENCODES, which is bigger than the bug
 * ----------------------------------------------------
 * `manualChunks` applies ONLY to `vite build`. Dev serves unbundled modules, so no
 * amount of `npm run dev` could ever surface it, and `npm run build` exited 0
 * throughout — a build succeeding tells you the bundle was WRITTEN, not that it can
 * be EVALUATED. Every gate in this repo was green while the production bundle could
 * not start. The first person to open one in a browser was the client.
 *
 * So this test reads the real `dist/` output. It is the only check here that looks at
 * build artefacts rather than source, because that is where this class of fault lives.
 *
 * It SKIPS when `dist/` is absent, so `npm test` on a clean checkout is not a
 * failure — but it fails loudly once a build exists and is wrong, which is the state
 * that matters before a deploy.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");
const built = existsSync(join(DIST, "index.html")) && existsSync(ASSETS);

describe.skipIf(!built)("production bundle", () => {
  const html = built ? readFileSync(join(DIST, "index.html"), "utf8") : "";
  const jsFiles = built
    ? readdirSync(ASSETS).filter((f) => f.endsWith(".js") && !f.endsWith(".map"))
    : [];

  /** The chunks the browser loads BEFORE the app can render anything. */
  function entryGraph(): string[] {
    // The entry script, plus anything index.html preloads, plus whatever the entry
    // statically imports — which for this app is the single boot chunk.
    const referenced = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+\.js)/g)].map((m) => m[1] ?? "");
    const seen = new Set<string>(referenced);
    for (const name of referenced) {
      const code = readFileSync(join(ASSETS, name), "utf8");
      // Static imports only: `import"./x.js"` / `from"./x.js"`. A DYNAMIC
      // `import("./x.js")` is deliberately not followed — being reachable only
      // dynamically is exactly what "out of the entry graph" means.
      for (const m of code.matchAll(/(?:^|[;\s}])(?:import|from)\s*"\.\/([A-Za-z0-9._-]+\.js)"/g)) {
        const dep = m[1];
        if (dep !== undefined) seen.add(dep);
      }
    }
    return [...seen];
  }

  it("emitted an entry and some chunks at all", () => {
    expect(jsFiles.length).toBeGreaterThan(3);
    expect(html).toMatch(/<script type="module"[^>]*src="\/assets\/index-[A-Za-z0-9._-]+\.js"/);
  });

  it("keeps the face engine OUT of the entry graph (architecture D-07)", () => {
    /*
      ~1.3 MB of face recognition must not be downloaded by an employee who only
      wants a payslip. This is guaranteed by the IMPORT STYLE — every consumer
      reaches it through `loadFaceModels`, a dynamic import — rather than by naming
      it in `manualChunks`, which is configuration that can drift.
    */
    const offenders = entryGraph().filter((name) => {
      const code = readFileSync(join(ASSETS, name), "utf8");
      return /tinyFaceDetector|faceLandmark68|FaceRecognitionNet/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("still emits the face engine as its own lazy chunk", () => {
    // The other half: out of the entry, but present and separate — if it had been
    // merged into one giant chunk, the gate would download it as part of everything.
    const faceChunks = jsFiles.filter((f) =>
      /tinyFaceDetector|FaceRecognitionNet/.test(readFileSync(join(ASSETS, f), "utf8")),
    );
    expect(faceChunks.length).toBeGreaterThan(0);
  });

  it("does not hand-split React away from the code that calls createContext", () => {
    /*
      THE ACTUAL BUG. Any chunk that reads `.createContext` must also contain React's
      own definition of it, or be able to reach it without a cycle. The reliable way
      to guarantee that is not to hand-assign vendor code at all, so this asserts the
      config stays out of the business of placing node_modules.
    */
    const config = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
    const active = config
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(active).not.toMatch(/manualChunks/);
  });
});
