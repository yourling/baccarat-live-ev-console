import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BrowserBridgeServer,
} from '../src/index.js';

const EXT_ORIGIN = `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}`;
const bridgeClientSource = readFileSync(
  new URL('../../../apps/browser-extension-shared/bridge-client.js', import.meta.url),
  'utf8',
);

describe('P1-8a bridge-client session and outbox overflow', () => {
  it('generates a fresh bridgeSessionId and resets bridgeSeq on every connect()', () => {
    // 静态契约：BRIDGE_SESSION_ID 不再是模块级常量，connect() 里重新生成且序号清零。
    expect(bridgeClientSource).not.toMatch(/var BRIDGE_SESSION_ID = \[/);
    expect(bridgeClientSource).toMatch(/var BRIDGE_SESSION_ID = '';/);
    expect(bridgeClientSource).toMatch(/BRIDGE_SESSION_ID = newBridgeSessionId\(\);/);
    expect(bridgeClientSource).toMatch(/bridgeMessageSeq = 0;/);
    // 溢出不再静默 shift。
    expect(bridgeClientSource).not.toMatch(/outbox\.shift\(\);\s*outbox\.push/);
    expect(bridgeClientSource).toMatch(/function resetBridgeOutbox\(/);
  });

  it('accepts a new sessionId at seq=1 after a sequence gap, without another SW restart', async () => {
    // 服务端契约：新 sessionId 重置基准；同 session 跳号仍然 1008（安全属性不能丢）。
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
    });
    const port = await server.start();
    const url = (installId: string) => `ws://127.0.0.1:${port}/?installId=${installId}`;

    // FIX(flaky): 未带 Origin 头的 ws 连接会在握手期被 401 拒绝并 emit 'error'，
    // 必须在构造后同 tick 挂监听，否则会变成 unhandled error。
    const connect = async (installId: string): Promise<WebSocket> => {
      const client = new WebSocket(url(installId), { origin: EXT_ORIGIN });
      client.on('error', () => undefined);
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      return client;
    };

    const first = await connect('session-test-install-1');
    const closedFirst = new Promise<{ code: number; reason: string }>(resolve => {
      first.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    try {
      first.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-a',
        bridgeSeq: 1,
      }));
      await new Promise(resolve => setTimeout(resolve, 30));
      // 同 session 跳号（模拟旧实现的 outbox 裁剪）→ 必须仍然 1008。
      first.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-a',
        bridgeSeq: 5,
      }));
      await expect(closedFirst).resolves.toMatchObject({ code: 1008 });
      expect(first.readyState).toBe(WebSocket.CLOSED);
    } finally {
      try { first.close(); } catch { /* already closed */ }
    }

    // 修复后的客户端会开一个**新 session**（seq 重新从 1 开始）→ 服务端接受。
    const second = await connect('session-test-install-1');
    try {
      const closedEarly = new Promise<number>(resolve => second.once('close', code => resolve(code)));
      second.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'Chrome',
        timestamp: new Date().toISOString(),
        executorProfileId: 'profile-session-1',
        bridgeSessionId: 'bridge-session-b',
        bridgeSeq: 1,
        seqReset: true,
      }));
      await new Promise(resolve => setTimeout(resolve, 120));
      // 没有被 1008 踢掉，且认证通过。
      expect(second.readyState).toBe(WebSocket.OPEN);
      expect(server.getExtensionStatus().authenticated).toBe(true);
      await expect(Promise.race([
        closedEarly.then(code => `closed:${code}`),
        Promise.resolve('open'),
      ])).resolves.toBe('open');
    } finally {
      second.close();
      await server.close();
    }
  });
});
