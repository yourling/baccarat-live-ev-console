import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/release/**'],
    server: {
      deps: {
        external: [/better-sqlite3/]
      }
    },
    pool: 'forks'
  }
});
