"use client";

import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="shell">
        <p className="error" role="alert">
          Something went wrong rendering this graph: {this.state.error.message}
        </p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
