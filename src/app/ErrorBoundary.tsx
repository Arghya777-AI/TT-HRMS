/**
 * ErrorBoundary — last line of defence. A render crash shows an honest card
 * with a correlation reference, never a white screen.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@/shared/ui/ErrorState";

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
