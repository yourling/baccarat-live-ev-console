import { rmSync } from 'node:fs';
import { build } from 'esbuild';
import { consoleBuildDefines } from './console-build-defines.mjs';

rmSync('electron-dist', { recursive: true, force: true });

await build({
  entryPoints: {
    main: 'electron-src/main.ts',
    preload: 'electron-src/preload.ts',
  },
  outdir: 'electron-dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'better-sqlite3'],
  define: consoleBuildDefines(),
  sourcemap: true,
  logLevel: 'info',
});
