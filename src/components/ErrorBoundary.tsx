// Tight error boundary. Wrap any panel/section you want to isolate from
// app-level blank-screen failures. The fallback prints the error to make
// React render crashes visible — no more "the right pane just disappeared"
// debugging sessions.

import { Component, type ReactNode } from "react";
import { logLine } from "@/lib/ipc";
import { i18n } from "@/lib/i18n";

interface Props { children: ReactNode; label?: string; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const lbl = this.props.label || "ErrorBoundary";
    // eslint-disable-next-line no-console
    console.error(`[${lbl}]`, error, info.componentStack);
    logLine(`${lbl}: ${error.message}\n${error.stack || ""}\n${info.componentStack || ""}`).catch(() => {});
  }
  reset = () => this.setState({ error: null });
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full w-full flex-col items-start gap-3 overflow-auto bg-[var(--color-bg-1)] p-4 text-[12.5px]">
        <div className="font-semibold text-[var(--color-err)]">
          {/* Class component, so no hook; i18n.t is fine here because the
              fallback only renders once, on crash. */}
          {i18n.t("chrome:errorBoundary.crashed", { label: this.props.label || i18n.t("chrome:errorBoundary.panel") })}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[var(--color-fg-dim)]">
          {this.state.error.message}
        </pre>
        {this.state.error.stack && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-fg-faint)]">
            {this.state.error.stack}
          </pre>
        )}
        <button
          onClick={this.reset}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-1 text-[12px] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)]"
        >{i18n.t("common:retry")}</button>
      </div>
    );
  }
}
