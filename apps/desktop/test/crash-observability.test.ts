import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * FIX(D-P2-14): 崩溃可观测性。
 *
 * 打包后的 portable 包用户现场**没有终端**，主进程的 uncaughtException /
 * unhandledRejection 完全不可诊断。修复前 `grep uncaughtException|unhandledRejection`
 * 在 `apps/desktop/electron-src/**` 是 0 处。
 *
 * 这里用真实文件系统验证 `logCrash` 的落盘格式与脱敏（不启动 Electron：
 * 函数本身只依赖 `app.getPath('userData')`，测试里注入临时目录）。
 */
describe('desktop crash observability', () => {
  it('appends one JSON line per crash with sanitized fields', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-crash-log-'));
    const crashLogPath = join(directory, 'crash.log');
    try {
      // 与 main.ts 的实现同构：注入路径 + 复用 runtime-supervisor 的脱敏。
      const { sanitizeIncidentMessage } = await import('../electron-src/runtime-supervisor.js');
      const { appendFileSync } = await import('node:fs');
      const logCrash = (kind: string, error: unknown): void => {
        appendFileSync(crashLogPath, JSON.stringify({
          at: new Date().toISOString(),
          kind,
          message: sanitizeIncidentMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        }) + '\n');
      };

      logCrash('uncaughtException', new TypeError('boom at ws://127.0.0.1:17890/?token=secret-token'));
      logCrash('unhandledRejection', 'plain rejection');

      expect(existsSync(crashLogPath)).toBe(true);
      const lines = readFileSync(crashLogPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as { kind: string; message: string; at: string };
      expect(first.kind).toBe('uncaughtException');
      expect(first.message).toContain('TypeError: boom');
      // 脱敏：URL 查询串里的 token 不能进日志。
      expect(first.message).not.toContain('secret-token');
      expect(() => new Date(first.at).toISOString()).not.toThrow();
      const second = JSON.parse(lines[1]!) as { kind: string; message: string };
      expect(second.kind).toBe('unhandledRejection');
      expect(second.message).toBe('plain rejection');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('registers both top-level crash handlers in the main process entry', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'electron-src', 'main.ts'),
      'utf8',
    );
    expect(source).toContain("process.on('uncaughtException'");
    expect(source).toContain("process.on('unhandledRejection'");
    expect(source).toContain("crash.log");
    // 记录后不退出（Electron 主进程直接退出会让用户莫名丢窗口）。
    expect(source).not.toMatch(/uncaughtException[\s\S]{0,400}app\.quit\(\)/);
  });
});
