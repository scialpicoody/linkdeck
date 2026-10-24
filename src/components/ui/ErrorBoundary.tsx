import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defense for the workbench shell. A throw during render
 * (e.g. a mygo binding used outside the Go host) must degrade to a readable
 * screen, never to an empty #root.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="grid h-screen w-full place-items-center bg-background p-6 text-foreground">
          <div className="max-w-md text-center">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The workbench hit an unexpected error and could not render.
            </p>
            <pre className="mt-3 max-h-40 overflow-auto rounded-[var(--radius)] border border-border bg-card p-3 text-left font-mono text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 min-h-9 rounded-[var(--radius)] bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
