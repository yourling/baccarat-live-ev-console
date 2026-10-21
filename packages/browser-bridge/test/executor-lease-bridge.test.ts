import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  type BrowserBridgeRuntimeEvent,
} from '../src/index.js';

/**
 * P0-1: 这些用例不传 `extensionApprovals`，桥处于兼容放行模式，但**带 installId** 是
 * 必要条件（缺 installId 只能拿 pending 角色）。行为与修复前一致：单连接拿 lease。
 */
const TEST_INSTALL_ID = 'lease-test-install-01';

function authenticatedExtensionClient(port: number): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
    { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
  );
}

function liveBetRequest(suffix = '1'): BetExecutionRequest {
  return {
    mode: 'live',
    reservationId: `rv-lease-${suffix}`,
    intent: {
      intentId: `intent-lease-${suffix}`,
      tableId: 'bc281koreanch281',
      shoeId: 'shoe-lease-1',
      handId: 'hand-lease-1',
      market: 'bankerPair',
      amount: 10,
      mode: 'live',
      idempotencyKey: `k-lease-${suffix}`,
      strategy: { type: 'fixed', market: 'bankerPair' },
      decisionSnapshotId: `decision-lease-${suffix}`,
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  };
}

async function openClient(port: number): Promise<WebSocket> {
  const client = authenticatedExtensionClient(port);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  return client;
}

function sendHello(
  client: WebSocket,
  opts: { sessionId: string; seq: number; profileId: string },
): void {
  client.send(JSON.stringify({
    kind: 'hello',
    extensionVersion: '0.1.0',
    browser: 'Chrome',
    timestamp: '2026-09-04T00:00:00.000Z',
    executorProfileId: opts.profileId,
    bridgeSessionId: opts.sessionId,
    bridgeSeq: opts.seq,
  }));
}

function collectMessages(client: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  client.on('message', data => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  return messages;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

async function waitForEvent(
  events: BrowserBridgeRuntimeEvent[],
  kind: BrowserBridgeRuntimeEvent['kind'],
  timeoutMs = 1_000,
): Promise<BrowserBridgeRuntimeEvent> {
  await waitUntil(() => events.some(event => event.kind === kind), timeoutMs);
  const found = events.find(event => event.kind === kind);
  if (!found) throw new Error(`missing ${kind}`);
  return found;
}

function acceptedReceipt(suffix = '1') {
  return {
    receiptId: `r-lease-${suffix}`,
    intentId: `intent-lease-${suffix}`,
    reservationId: `rv-lease-${suffix}`,
    status: 'ACCEPTED',
    amount: 10,
    market: 'bankerPair',
    mode: 'live',
    createdAt: '2026-09-04T00:00:01.000Z',
  };
}

describe('browser bridge executor lease', () => {
  it('grants one lease, rejects a second executor, and never sends it a betRequest', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 1_000,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const first = await openClient(port);
    const firstMessages = collectMessages(first);
    let firstBetSeq = 2;
    first.on('message', data => {
      const message = JSON.parse(data.toString()) as {
        kind?: string;
        requestId?: string;
      };
      if (message.kind !== 'betRequest' || !message.requestId) return;
      first.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: acceptedReceipt(),
        bridgeSessionId: 'bridge-session-owner-01',
        bridgeSeq: firstBetSeq,
      }));
      firstBetSeq += 1;
    });

    try {
      sendHello(first, {
        sessionId: 'bridge-session-owner-01',
        seq: 1,
        profileId: 'chrome-profile-owner-01',
      });
      await waitForEvent(events, 'executor-lease-acquired');
      expect(server.getExecutorStatus()).toMatchObject({
        active_executor_count: 1,
        profileId: 'chrome-profile-owner-01',
      });
      expect(events.filter(event => event.kind === 'executor-lease-acquired')).toHaveLength(1);

      const secondClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('second socket close timeout')), 2000);
        const second = authenticatedExtensionClient(port);
        second.once('close', (code: number, reason: Buffer) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
        second.once('error', () => undefined);
      });
      const closed = await secondClosed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toContain('extension already connected');
      expect(events.filter(event => event.kind === 'executor-lease-acquired')).toHaveLength(1);
      expect(server.getExecutorStatus().active_executor_count).toBe(1);

      await expect(server.requestBet(liveBetRequest())).resolves.toMatchObject({
        receiptId: 'r-lease-1',
      });
      expect(firstMessages.some(message => message.kind === 'betRequest')).toBe(true);
      expect(firstMessages.find(message => message.kind === 'betRequest')).toMatchObject({
        leaseId: expect.any(String),
        signature: expect.stringMatching(/^[0-9a-f]{64}$/i),
      });
    } finally {
      first.close();
      await server.close();
    }
  });

  it('rebinds the same leaseId after a service-worker restart', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 1_000,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const first = await openClient(port);
    try {
      sendHello(first, {
        sessionId: 'bridge-session-sw-gen-1',
        seq: 1,
        profileId: 'chrome-profile-sw-01',
      });
      const acquired = await waitForEvent(events, 'executor-lease-acquired') as Extract<
        BrowserBridgeRuntimeEvent,
        { kind: 'executor-lease-acquired' }
      >;
      const leaseId = acquired.leaseId;
      expect(acquired.reacquired).toBe(false);
      expect(server.getExecutorStatus()).toMatchObject({
        active_executor_count: 1,
        leaseId,
        profileId: 'chrome-profile-sw-01',
      });
      expect(server.getExecutorStatus()).not.toHaveProperty('hostChannelId');

      await new Promise<void>(resolve => {
        first.once('close', () => resolve());
        first.close();
      });
      // FIX(P1-1 竞态): 旧写法等的是 active_executor_count === 1 —— 但 lease 在 close 前
      // 就已经是 1（claimant 被 park，lease 仍 active），条件恒真，等于没等。
      // 真正要等的是"旧 socket 已经从唯一扩展槽里消失"，否则紧接着的重连会撞上
      // admitExtensionSocket 的 sockets.size > 0 判定。
      await waitUntil(() => server.getExtensionStatus().connectionCount === 0);
      const acquiredBeforeRestart = events.filter(event => event.kind === 'executor-lease-acquired').length;

      const restarted = await openClient(port);
      const restartedMessages = collectMessages(restarted);
      let restartedBetSeq = 2;
      restarted.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind?: string; requestId?: string };
        if (message.kind !== 'betRequest' || !message.requestId) return;
        restarted.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId,
          receipt: acceptedReceipt('rebind'),
          bridgeSessionId: 'bridge-session-sw-gen-2',
          bridgeSeq: restartedBetSeq,
        }));
        restartedBetSeq += 1;
      });
      sendHello(restarted, {
        sessionId: 'bridge-session-sw-gen-2',
        seq: 1,
        profileId: 'chrome-profile-sw-01',
      });
      await waitUntil(
        () => events.filter(event => event.kind === 'executor-lease-acquired').length > acquiredBeforeRestart,
      );
      const acquiredEvents = events.filter(
        (event): event is Extract<BrowserBridgeRuntimeEvent, { kind: 'executor-lease-acquired' }> =>
          event.kind === 'executor-lease-acquired',
      );
      expect(new Set(acquiredEvents.map(event => event.leaseId)).size).toBe(1);
      expect(acquiredEvents.at(-1)).toMatchObject({
        leaseId,
        reacquired: true,
        profileId: 'chrome-profile-sw-01',
      });
      expect(server.getExecutorStatus().active_executor_count).toBe(1);
      expect(server.getExecutorStatus().leaseId).toBe(leaseId);
      await waitUntil(() => restartedMessages.some(message => message.kind === 'executorLeaseGranted'));
      expect(restartedMessages.find(message => message.kind === 'executorLeaseGranted')).toMatchObject({
        leaseId,
        reacquired: true,
      });

      await expect(server.requestBet(liveBetRequest('rebind'))).resolves.toMatchObject({
        receiptId: 'r-lease-rebind',
      });
      expect(restartedMessages.some(message => message.kind === 'betRequest')).toBe(true);
      restarted.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a parallel Electron channel and does not dispatch a bet on it', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 1_000,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const client = await openClient(port);
    const messages = collectMessages(client);
    try {
      sendHello(client, {
        sessionId: 'bridge-session-parallel-01',
        seq: 1,
        profileId: 'chrome-profile-parallel-01',
      });
      await waitForEvent(events, 'executor-lease-acquired');
      expect(server.claimHostExecutionChannel('desktop-primary')).toEqual({
        ok: true,
        channelId: 'desktop-primary',
      });
      expect(server.claimHostExecutionChannel('desktop-secondary')).toMatchObject({
        ok: false,
        reason: 'parallel-execution-channel-rejected',
        activeChannelId: 'desktop-primary',
      });
      expect(server.getExecutorStatus()).toMatchObject({
        active_executor_count: 1,
        hostChannelId: 'desktop-primary',
      });

      const isolated = new BrowserBridgeServer({
        port: 0,
        betTimeoutMs: 200,
        requireExtensionSequence: true,
        allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
        extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      });
      const isolatedPort = await isolated.start();
      const isolatedClient = await openClient(isolatedPort);
      let isolatedBets = 0;
      isolatedClient.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind?: string };
        if (message.kind === 'betRequest') isolatedBets += 1;
      });
      try {
        sendHello(isolatedClient, {
          sessionId: 'bridge-session-parallel-02',
          seq: 1,
          profileId: 'chrome-profile-parallel-02',
        });
        await waitUntil(() => isolated.getExecutorStatus().active_executor_count === 1);
        expect(isolated.claimHostExecutionChannel('electron-secondary')).toEqual({
          ok: true,
          channelId: 'electron-secondary',
        });
        await expect(isolated.requestBet(liveBetRequest('blocked'))).rejects.toThrow(
          /parallel Electron execution channel rejected/,
        );
        expect(isolatedBets).toBe(0);
        expect(isolated.getExecutorStatus().active_executor_count).toBe(1);
      } finally {
        isolatedClient.close();
        await isolated.close();
      }

      expect(messages.some(message => message.kind === 'betRequest')).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('admits a reconnecting extension when the previous socket is already closed', async () => {
    // FIX(P1-1): 旧实现无条件 `sockets.size > 0 → 1008`，扩展 SW 重启时新连接会被
    // 永久挤掉（d-desktop P1-1 / executor-lease 重绑竞态）。现在只拒绝**仍然 OPEN** 的旧 socket。
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 1_000,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const first = await openClient(port);
    try {
      sendHello(first, {
        sessionId: 'bridge-session-evict-1',
        seq: 1,
        profileId: 'chrome-profile-evict-01',
      });
      await waitUntil(() => server.getExtensionStatus().connectionCount === 1);

      // 并发第二个连接：旧的仍然 OPEN → 必须 1008（唯一槽约束不能松）。
      const concurrent = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
        { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
      );
      concurrent.on('error', () => undefined);
      const concurrentClose = await new Promise<number>(resolve => {
        const timer = setTimeout(() => resolve(-1), 1_000);
        concurrent.on('close', code => { clearTimeout(timer); resolve(code); });
      });
      expect(concurrentClose).toBe(1008);

      // 关闭旧连接后**不等** close 传播，立刻重连：必须被接纳（旧 socket 已被判死）。
      first.close();
      const restarted = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}&installId=${TEST_INSTALL_ID}`,
        { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
      );
      restarted.on('error', () => undefined);
      const opened = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 1_000);
        restarted.once('open', () => { clearTimeout(timer); resolve(true); });
        restarted.once('close', () => { clearTimeout(timer); resolve(false); });
      });
      expect(opened).toBe(true);
      restarted.close();
    } finally {
      try { first.close(); } catch { /* already closed */ }
      await server.close();
    }
  });
});
