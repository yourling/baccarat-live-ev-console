/**
 * 把 apps/browser-extension-shared/ 下的共享文件同步进三个扩展目录。
 * 扩展是 extraResources 打包的非 workspace 目录，无法在运行期共享模块；
 * 构建期复制保持单一事实来源。git 中跟踪同步后的副本。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = join(root, 'apps', 'browser-extension-shared');
// FIX(P0-1 残余风险): popup 让操作员看到本扩展 installId，与桌面待批准列表做带外比对。
const sharedFiles = ['bridge-client.js', 'bridge-popup.html', 'bridge-popup.js'];
const targets = [
  join(root, 'apps', 'browser-extension'),
  join(root, 'apps', 'browser-extension-bg'),
  join(root, 'apps', 'browser-extension-winfinity'),
];

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of sharedFiles) {
    copyFileSync(join(sharedDir, file), join(targetDir, file));
  }
}
console.log(`${sharedFiles.length} shared extension files synced into ${targets.length} extension dirs`);
