/**
 * 把 apps/browser-extension-shared/bridge-client.js 同步进三个扩展目录。
 * 扩展是 extraResources 打包的非 workspace 目录，无法在运行期共享模块；
 * 构建期复制保持单一事实来源。git 中跟踪同步后的副本。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps', 'browser-extension-shared', 'bridge-client.js');
const targets = [
  join(root, 'apps', 'browser-extension'),
  join(root, 'apps', 'browser-extension-bg'),
  join(root, 'apps', 'browser-extension-winfinity'),
];

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, join(targetDir, 'bridge-client.js'));
}
console.log(`bridge-client.js synced into ${targets.length} extension dirs`);
