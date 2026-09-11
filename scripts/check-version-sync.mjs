/**
 * 版本号一致性检查。
 *
 * AGENTS.md 要求每次合入修改把版本 patch +1，但只点名了三处
 * （CONSOLE_VERSION、根 package.json、apps/desktop/package.json）。
 * 实践中 `package-lock.json` 里的同一组版本号被反复漏掉 ——
 * 审查时它停留在 1.0.1 而 package.json 已经到 1.0.10，差了 9 个版本。
 *
 * 版本漂移不会让构建失败，但会让人对"到底发布的是哪一版"失去判断，
 * 也会在下次 `npm install` 时产生意料之外的 diff。这里一次性全部对齐。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readConsoleVersion() {
  const source = readFileSync(
    path.join(repoRoot, 'apps/desktop/src/console-build-info.ts'),
    'utf8',
  );
  const match = /export const CONSOLE_VERSION = '([^']+)'/.exec(source);
  if (!match) {
    throw new Error('could not find CONSOLE_VERSION in apps/desktop/src/console-build-info.ts');
  }
  return match[1];
}

const rootPackage = readJson('package.json');
const desktopPackage = readJson('apps/desktop/package.json');
const lockfile = readJson('package-lock.json');

const observed = [
  ['package.json', rootPackage.version],
  ['apps/desktop/package.json', desktopPackage.version],
  ['apps/desktop/src/console-build-info.ts (CONSOLE_VERSION)', readConsoleVersion()],
  ['package-lock.json (root)', lockfile.version],
  ['package-lock.json (packages[""])', lockfile.packages?.['']?.version],
  ['package-lock.json (packages["apps/desktop"])', lockfile.packages?.['apps/desktop']?.version],
];

const unique = new Set(observed.map(([, version]) => version));
if (unique.size !== 1 || unique.has(undefined)) {
  console.error('version mismatch across the release surfaces:');
  for (const [source, version] of observed) {
    console.error(`  ${source}: ${String(version)}`);
  }
  console.error('');
  console.error('bump every entry together (see AGENTS.md) and update package-lock.json too.');
  process.exit(1);
}

console.log(`version sync ok (${observed[0][1]})`);
