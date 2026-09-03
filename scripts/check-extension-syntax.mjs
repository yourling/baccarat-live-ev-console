import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'apps', 'browser-extension');
const files = readdirSync(extensionDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => join(extensionDir, file));

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`extension syntax ok (${files.length} files)`);