import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../utils/logger.js";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      source: "react-error-boundary",
      message: error.message || "React render error",
      stack: error.stack,
      context: {
        componentStack: info.componentStack?.slice(0, 2000),
      },
    });
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          maxWidth: 640,
          margin: "48px auto",
          padding: "24px",
          borderRadius: 12,
          border: "1px solid #e2d9c8",
          background: "#fffdf8",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#2a241e",
        }}
      >
        <h2 style={{ marginTop: 0, color: "#b93a2b" }}>Something went wrong</h2>
        <p style={{ lineHeight: 1.5 }}>
          An unexpected UI error occurred. It has been logged to the server log file (
          <code>fuluoxiaojie-data/logs/app.log</code>) and the browser console.
        </p>
        <pre
          style={{
            padding: 12,
            borderRadius: 8,
            background: "#f6f1e7",
            overflowX: "auto",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {this.state.error.message}
          {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 12,
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: "#b93a2b",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Reload page
        </button>
      </div>
    );
  }
}
