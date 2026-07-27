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
 * ONE reload, ever, per tab.
 *
 * `sessionStorage` rather than a field on the component: the reload destroys the
 * component, so anything held in memory is gone by the time the guard is needed.
 * Without it, an error that merely LOOKS like a stale chunk — a genuinely offline
 * device, a CDN outage, a blocked request — would reload, fail, reload, and pin the
 * gate in a loop that is far worse than the blank screen it was meant to fix.
 */
const RELOAD_FLAG = "tt-hrms:chunk-reloaded";

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
    let alreadyTried = true;
    try {
      alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === "1";
      if (!alreadyTried) sessionStorage.setItem(RELOAD_FLAG, "1");
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
