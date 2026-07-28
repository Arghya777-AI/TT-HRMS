/**
 * ErrorBoundary — last line of defence. A render crash shows an honest card
 * with a correlation reference, never a white screen.
 *
 * It also recovers from ONE failure that is not really a crash: a stale tab whose
 * lazily-imported chunk no longer exists. See `isStaleChunkError`.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/shared/ui/ErrorState";

/**
 * Did this error happen because the app was redeployed under a tab that was already
 * open?
 *
 * Routes are lazily imported and Vite names every chunk by content hash, so a deploy
 * replaces `Kiosk.page-ABC123.js` with a new hash and deletes the old one. A tab
 * opened before the deploy still holds the OLD manifest, so the moment it navigates
 * to a route it has not visited yet, the import rejects and the screen goes blank.
 *
 * A kiosk is exactly the tab this hits: it sits open on a gate for an entire shift,
 * and the person holding it has no idea a deploy happened. Reloading fixes it
 * completely — the new index.html brings the new manifest — so the only sensible
 * response is to reload once, automatically.
 *
 * The browsers disagree on the wording, hence matching several: Chrome says "Failed
 * to fetch dynamically imported module", Firefox "error loading dynamically imported
 * module", Safari "Importing a module script failed", and webpack-era tooling threw
 * `ChunkLoadError`.
 */
function isStaleChunkError(error: Error): boolean {
  const text = `${error.name} ${error.message}`;
  return (
    /ChunkLoadError/i.test(text) ||
    /failed to fetch dynamically imported module/i.test(text) ||
    /error loading dynamically imported module/i.test(text) ||
    /importing a module script failed/i.test(text)
  );
}

/**
 * ONE reload PER BUILD, not one reload ever.
 *
 * This used to store a bare "1" and refuse to reload a second time for the life of the
 * tab. That is correct protection against the wrong thing. It stops the loop that
 * matters — an offline device or a CDN outage reloading forever — but it also means the
 * SECOND deploy while a tab is open is unrecoverable: the flag is already set, so the
 * tab shows "Failed to fetch dynamically imported module" and stays there. On a day with
 * six deploys, every tab open since the first one is stuck.
 *
 * So the flag now records WHICH BUILD reloaded, and the test is "have I already reloaded
 * for this build?" rather than "have I ever reloaded?":
 *
 *   reload happened, tab came back on a NEW build, new stale chunk  -> reload again
 *   reload happened, tab came back on the SAME build                -> stop, show the card
 *
 * The second line is the loop guard, and it is strictly stronger than a counter: if
 * reloading does not change the build then reloading cannot possibly help, whatever the
 * reason, and the honest thing is to say so.
 *
 * `sessionStorage` rather than a field on the component, because the reload destroys the
 * component — anything held in memory is gone by the time the guard is needed.
 */
const RELOAD_FLAG = "tt-hrms:chunk-reloaded-build";

/**
 * A tag identifying the build this document was served with — no build-time config and
 * no clock needed.
 *
 * Vite emits the entry as `/assets/index-<contenthash>.js`, so the entry script's own URL
 * IS the build identity: a deploy that changes any code changes that hash. Reading it off
 * the DOM means the tag is whatever this page actually loaded, which is exactly the thing
 * a reload is trying to change.
 *
 * Falls back to a constant when no hashed module script is present (the dev server, or a
 * future non-hashed build). A constant degrades to the OLD behaviour — one reload per tab
 * — which is the safe direction to fail in.
 */
function buildTag(): string {
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return entry?.getAttribute("src") ?? "unhashed";
}

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sentry hooks in here later; console keeps local debugging usable.
    console.error("[tt-hrms] render error", error, info.componentStack);

    if (!isStaleChunkError(error)) return;
    const tag = buildTag();
    let alreadyTried = true;
    try {
      // "Already tried" now means "already reloaded FOR THIS BUILD". A tab that
      // reloaded, came back on a newer build, and then met another stale chunk gets a
      // fresh reload; a tab that reloads back into the same build does not, because
      // reloading demonstrably is not helping.
      alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === tag;
      if (!alreadyTried) sessionStorage.setItem(RELOAD_FLAG, tag);
    } catch {
      // Private mode or a locked-down webview can refuse sessionStorage entirely.
      // Without the guard a reload could loop, so do nothing and let the error card
      // stand — a visible message beats an unbounded refresh on a gate device.
      return;
    }
    if (alreadyTried) return;
    console.warn("[tt-hrms] stale chunk after a deploy — reloading once");
    window.location.reload();
  }

  private readonly reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="container py-10">
          <ErrorState error={error} retry={this.reset} />
        </div>
      );
    }
    return this.props.children;
  }
}
