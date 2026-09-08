import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [
  join(root, 'apps', 'browser-extension'),
  join(root, 'apps', 'browser-extension-bg'),
  join(root, 'apps', 'browser-extension-winfinity'),
];

let failed = false;
let count = 0;
for (const extensionDir of dirs) {
  const files = readdirSync(extensionDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => join(extensionDir, file));
  for (const file of files) {
    count += 1;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failed = true;
      process.stderr.write(result.stderr);
    }
  }
}

if (failed) process.exit(1);
console.log(`extension syntax ok (${count} files)`);
