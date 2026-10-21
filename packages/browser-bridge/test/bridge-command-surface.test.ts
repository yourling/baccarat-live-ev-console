/**
 * P0-2 回归：`/command` 的危险命令面已从白名单删除。
 *
 * 修复前（review/scripts/ledger/b7e）：`/command` 只校验可伪造的 loopback Origin，
 * 本机任意进程可下发 liveOn / liveOff / reloadExtension / trustedOn / trustedOff /
 * calibrate / calibrateClear / start|stopPragmaticNetworkCapture。
 * 其中 liveOn 会让扩展把 liveBetSessionEnabled 置 true，**绕过桌面端 live gate**。
 *
 * 修复后：白名单只保留只读/诊断命令；内部 gate 走 setLiveBetEnabled() → broadcastToSockets，
 * 不经过白名单，因此功能不受影响（本文件的最后一个用例锁定这一点）。
 */
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BrowserBridgeServer,
} from '../src/index.js';

const EXT_ORIGIN = `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}`;
const TEST_INSTALL_ID = 'command-test-install-1';
const REMOVED_COMMANDS = [
  'liveOn',
  'liveOff',
  'reloadExtension',
  'trustedOn',
  'trustedOff',
  'calibrate',
  'calibrateClear',
  'startPragmaticNetworkCapture',
  'stopPragmaticNetworkCapture',
] as const;
const RETAINED_COMMANDS = [
  'probeBetReadiness',
  'replayRuntimeState',
  'probeExtensionManifest',
] as const;

async function openClient(url: string, origin: string): Promise<WebSocket> {
  const client = new WebSocket(url, { origin });
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return client;
}

async function settle(ms = 120): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('P0-2 /command dangerous command surface', () => {
  it('does not forward any removed dangerous command to the extension socket', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const extension = await openClient(
      `ws://127.0.0.1:${port}/?installId=${TEST_INSTALL_ID}`,
      EXT_ORIGIN,
    );
    const command = await openClient(`ws://127.0.0.1:${port}/command`, 'http://127.0.0.1');
    const received: string[] = [];
    extension.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind?: string; name?: string };
      if (message.kind === 'command' && message.name) received.push(message.name);
    });
    try {
      for (const name of REMOVED_COMMANDS) {
        command.send(JSON.stringify({ kind: 'command', name }));
      }
      await settle();

      // 一个都没转发。
      expect(received).toEqual([]);
      // 每个都被显式拒绝并记日志（[bridge-command-rejected]），不是静默丢弃。
      const rejectedNames = errorSpy.mock.calls
        .filter(([tag]) => tag === '[bridge-command-rejected]')
        .map(([, name]) => name);
      expect(rejectedNames.sort()).toEqual([...REMOVED_COMMANDS].sort());
    } finally {
      extension.close();
      command.close();
      await server.close();
      errorSpy.mockRestore();
    }
  });

  it('still forwards the retained read-only commands', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const extension = await openClient(
      `ws://127.0.0.1:${port}/?installId=${TEST_INSTALL_ID}`,
      EXT_ORIGIN,
    );
    const command = await openClient(`ws://127.0.0.1:${port}/command`, 'http://127.0.0.1');
    const received: Array<{ name?: string; tableIds?: readonly string[] }> = [];
    extension.on('message', data => {
      const message = JSON.parse(data.toString()) as {
        kind?: string;
        name?: string;
        tableIds?: readonly string[];
      };
      if (message.kind === 'command' && message.name) received.push(message);
    });
    try {
      for (const name of RETAINED_COMMANDS) {
        command.send(JSON.stringify({ kind: 'command', name, tableIds: ['D055'] }));
      }
      await settle();

      expect(received.map(message => message.name).sort()).toEqual([...RETAINED_COMMANDS].sort());
      for (const message of received) expect(message.tableIds).toEqual(['D055']);
    } finally {
      extension.close();
      command.close();
      await server.close();
    }
  });

  it('keeps the desktop live gate working through setLiveBetEnabled (internal broadcast, not /command)', async () => {
    // 这是 P0-2 的**功能不回归**断言：删掉 /command 的 liveOn 后，桌面端 live gate
    // 仍然必须能让扩展收到 {kind:'command', name:'liveOn'}。
    const server = new BrowserBridgeServer({ port: 0, requireExtensionSequence: true });
    const port = await server.start();
    const extension = await openClient(
      `ws://127.0.0.1:${port}/?installId=${TEST_INSTALL_ID}`,
      EXT_ORIGIN,
    );
    const commands: string[] = [];
    extension.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind?: string; name?: string };
      if (message.kind === 'command' && message.name) commands.push(message.name);
    });
    try {
      // 未认证前 fail-closed。
      expect(() => server.setLiveBetEnabled(true)).toThrow(/authenticated extension sequence/i);
      extension.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'Chrome',
        timestamp: new Date().toISOString(),
        executorProfileId: 'profile-live-gate-1',
        bridgeSessionId: 'live-gate-session-1',
        bridgeSeq: 1,
      }));
      const started = Date.now();
      while (!server.getExtensionStatus().authenticated && Date.now() - started < 1_500) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(server.getExtensionStatus().authenticated).toBe(true);

      server.setLiveBetEnabled(true);
      server.setLiveBetEnabled(false);
      await settle();
      expect(commands).toEqual(['liveOn', 'liveOff']);
    } finally {
      extension.close();
      await server.close();
    }
  });
});
