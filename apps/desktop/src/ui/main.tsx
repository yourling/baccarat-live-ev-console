import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== '1') {
  void import('react-grab');
  void import('react-scan');
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state = { error: undefined as string | undefined };

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('desktop ui crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#e6edf3' }}>
          <h1>中控界面无法渲染</h1>
          <p>{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><RootErrorBoundary><App /></RootErrorBoundary></React.StrictMode>);
