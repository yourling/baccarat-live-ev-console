import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== '1') {
  void import('react-grab');
  void import('react-scan');
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
