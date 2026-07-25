import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /// Shown in the panel so the user knows which screen failed, and used to reset the
  /// boundary: when it changes (i.e. the user navigates elsewhere), a previously failed
  /// screen is given a clean slate instead of staying broken for the rest of the session.
  resetKey?: string;
  label?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  shownFor: string | undefined;
}

/// Stops one screen's render error from blanking the entire window.
///
/// Without this, any throw during render unmounts the whole React tree, leaving an empty
/// `#root` — and since the app background is `#121314` in dark mode, the result is a
/// completely black window with no UI and no explanation. That is indistinguishable to
/// the user from a hard crash, and it is exactly the "screen goes dark" symptom reported
/// against v0.1.16. A caught error is far more useful than a dead window: the screen that
/// failed says so, the message is copyable for a bug report, and the rest of the app —
/// sidebar, other tabs, an ingest already running — keeps working.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, shownFor: undefined };

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    // Navigating to a different screen clears a previous screen's error.
    if (state.error && state.shownFor !== props.resetKey) {
      return { error: null, info: null, shownFor: props.resetKey };
    }
    if (!state.error && state.shownFor !== props.resetKey) {
      return { ...state, shownFor: props.resetKey };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on console (not just in state) so it lands in the webview inspector and in any
    // log the user captures when reporting the failure.
    console.error("[ErrorBoundary] render failed:", error, info.componentStack);
    this.setState({ info });
  }

  private reset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    const { error, info } = this.state;
    if (!error) {
      return this.props.children;
    }

    const where = this.props.label ? `The ${this.props.label} screen` : "This screen";
    const details = [error.stack || `${error.name}: ${error.message}`, info?.componentStack]
      .filter(Boolean)
      .join("\n");

    return (
      <div className="flex min-w-0 flex-1 items-start justify-center p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-mist bg-paper p-5 shadow-panel">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
              <AlertTriangle size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold">{where} hit an error</div>
              <p className="mt-1 text-sm leading-5 text-graphite">
                The rest of Ingest Pilot is still running — switch tabs, or try again. If this
                keeps happening, copy the details below into a bug report.
              </p>

              <div className="mt-3 flex gap-2">
                <button
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={this.reset}
                  type="button"
                >
                  <RefreshCw size={13} /> Try again
                </button>
                <button
                  className="h-8 rounded-lg border border-mist bg-white px-3 text-xs font-semibold text-graphite transition hover:bg-porcelain"
                  onClick={() => void navigator.clipboard?.writeText(details)}
                  type="button"
                >
                  Copy details
                </button>
              </div>

              <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-porcelain p-3 text-[11px] leading-4 text-graphite">
                {details}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
