import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    alias: {
      'node:crypto': path.resolve(__dirname, 'src/node-crypto-shim.ts'),
    },
  },
  plugins: [
    react(),
    {
      name: 'electron-file-protocol',
      transformIndexHtml(html) {
        return html.replace(/ crossorigin(="anonymous")?/g, '');
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
  }
});
