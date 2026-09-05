/**
 * Loading a route chunk that the running shell can no longer fetch.
 *
 * ── WHAT PEOPLE SEE ──────────────────────────────────────────────────────────
 * "Failed to fetch dynamically imported module: .../assets/Home.page-rwB3PVrE.js"
 *
 * and the page never renders. It is not a bug in the page. Vite fingerprints every chunk, so
 * a deploy replaces `Home.page-<old>.js` with `Home.page-<new>.js` — and a browser that
 * loaded the shell BEFORE the deploy is still holding a module graph that names the old file.
 * It asks for a chunk this deployment does not serve, the import rejects, and React's `lazy`
 * has nothing to render.
 *
 * The window is small but it is exactly the wrong window: an employee who left the tab open
 * overnight opens it at 8am, the night's deploy has landed, and the first thing they touch is
 * dead. Nothing they can do — the app is broken until they know to hard-reload, which they
 * do not.
 *
 * ── WHY A RELOAD IS THE HONEST FIX, AND WHY ONLY ONCE ────────────────────────
 * Nothing in the running page can repair this: the module it needs no longer exists at the
 * name it knows. Fetching a fresh document is the only way to learn the new names, so on a
 * chunk-load failure the app reloads itself.
 *
 * Guarded by `sessionStorage`, because a reload loop is far worse than an error message. If a
 * reload has already been tried for this tab and the import STILL fails, the failure is
 * something else — the asset really is missing, the network really is down — and it is
 * rethrown so the error boundary shows it rather than the tab spinning forever.
 *
 * The flag clears on the first successful load, so a genuine failure weeks later still gets
 * its one recovery attempt.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const FLAG = "tt.chunk-reload-attempted";

/**
 * Is this the failure mode a reload can fix?
 *
 * Matched on the message rather than a type, because browsers disagree: Chrome throws
 * `TypeError: Failed to fetch dynamically imported module`, Firefox `error loading dynamically
 * imported module`, Safari `Importing a module script failed`. A narrow match keeps a genuine
 * runtime error inside the page from triggering a reload that would hide it.
 */
export function isChunkLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /Failed to fetch dynamically imported/i.test(message) ||
    /ChunkLoadError/i.test(message)
  );
}

/** `sessionStorage` throws in some privacy modes; a recovery path must not die on that. */
function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}
function writeFlag(value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(FLAG, "1");
    else window.sessionStorage.removeItem(FLAG);
  } catch {
    /* A tab that cannot remember gets one attempt per navigation. Still better than none. */
  }
}

/**
 * `React.lazy`, but a stale-chunk failure reloads the page once instead of rendering an error
 * nobody can act on.
 */
export function lazyWithRecovery<T extends ComponentType>(
  loader: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await loader();
      // Loaded: this tab is on a consistent build again.
      writeFlag(false);
      return mod;
    } catch (error) {
      if (isChunkLoadFailure(error) && !readFlag()) {
        writeFlag(true);
        window.location.reload();
        /*
          Never resolves. The reload is already underway, and resolving with a placeholder
          would flash it for the moment before the document is replaced.
        */
        return await new Promise<{ default: T }>(() => undefined);
      }
      throw error;
    }
  });
}
