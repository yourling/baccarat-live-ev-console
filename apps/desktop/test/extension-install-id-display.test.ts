import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件位于 apps/desktop/test/，向上三层即仓库根。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/**
 * FIX(P0-1 残余风险): 「installId + 操作员批准」本质上仍是 TOFU ——
 * 桥无法校验扩展自述的 installId。唯一能把"盲批"变成"可验证比对"的动作，
 * 是让真扩展自己展示 installId，让操作员与桌面待批准列表做**带外**比对。
 *
 * 本测试锁住三件事，防止展示面悄悄失效：
 *  1. 三个扩展的 action 都挂上了共享 popup（否则操作员看不到 installId）；
 *  2. popup 读取的 storage key 与 background 生成时用的是同一个；
 *  3. 两处的 installId 生成规则一致（16 字节 → 32 hex），否则显示的前 8 位
 *     会对不上桌面待批准列表。
 */
describe('extension bridge installId display (P0-1 residual risk)', () => {
  const extensions = [
    'apps/browser-extension',
    'apps/browser-extension-bg',
    'apps/browser-extension-winfinity',
  ];

  it('wires the shared popup into every bundled extension', () => {
    for (const dir of extensions) {
      const manifest = JSON.parse(read(`${dir}/manifest.json`)) as {
        action?: { default_popup?: string };
      };
      expect(manifest.action?.default_popup, `${dir} must open the installId popup`).toBe('bridge-popup.html');
    }
  });

  it('shows the same storage key that the background worker generates', () => {
    for (const dir of extensions) {
      const background = read(`${dir}/background.js`);
      const popup = read(`${dir}/bridge-popup.js`);
      expect(background).toContain("bridgeInstallId");
      expect(popup).toContain("'bridgeInstallId'");
    }
  });

  it('keeps the installId generation rule identical in background and popup', () => {
    for (const dir of extensions) {
      const background = read(`${dir}/background.js`);
      const popup = read(`${dir}/bridge-popup.js`);
      // 同一生成规则：16 字节随机 → 每字节两位 hex → 32 hex。
      for (const source of [background, popup]) {
        expect(source).toContain('new Uint8Array(16)');
        expect(source).toContain("toString(16)");
        expect(source).toContain('padStart(2, \'0\')');
      }
    }
  });

  it('renders only the first 8 characters so the popup matches the desktop short form', () => {
    const popup = read('apps/browser-extension/bridge-popup.js');
    expect(popup).toContain('slice(0, 8)');
  });
});
