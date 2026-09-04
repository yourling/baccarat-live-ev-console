import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BetExecutionRequest } from '@baccarat/adapter-contract';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  type BrowserBridgeRuntimeEvent,
} from '../src/index.js';

function authenticatedExtensionClient(port: number): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
    { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
  );
}

function liveBetRequest(): BetExecutionRequest {
  return {
    mode: 'live',
    reservationId: 'rv-lease-1',
    intent: {
      intentId: 'intent-lease-1',
      tableId: 'bc281koreanch281',
      shoeId: 'shoe-1',
      handId: 'hand-1',
      market: 'bankerPair',
      amount: 10,
      mode: 'live',
      idempotencyKey: 'k-lease-1',
      strategy: { type: 'fixed', market: 'bankerPair' },
      decisionSnapshotId: 'decision-lease-1',
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  };
}

async function openClient(port: number): Promise<WebSocket> {
  const client = authenticatedExtensionClient(port);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
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

async function waitForEvent(
  events: BrowserBridgeRuntimeEvent[],
  kind: BrowserBridgeRuntimeEvent['kind'],
  timeoutMs = 500,
): Promise<BrowserBridgeRuntimeEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(event => event.kind === kind);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${kind}`);
}

describe('browser bridge executor lease', () => {
  it('grants one lease, rejects a second executor, and never sends it a bet', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 200,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const first = await openClient(port);
    const second = await openClient(port);
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    first.on('message', data => {
      firstMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    second.on('message', data => {
      secondMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    try {
      sendHello(first, {
        sessionId: 'bridge-session-first',
        seq: 1,
        profileId: 'chrome-profile-alpha',
      });
      await waitForEvent(events, 'executor-lease-acquired');
      expect(server.getExecutorStatus()).toMatchObject({
        active_executor_count: 1,
      });
      const acquiredEvents = events.filter(event => event.kind === 'executor-lease-acquired');
      expect(acquiredEvents).toHaveLength(1);

      sendHello(second, {
        sessionId: 'bridge-session-second',
        seq: 1,
        profileId: 'chrome-profile-alpha',
      });
      await waitForEvent(events, 'executor-lease-rejected');
      expect(events.filter(event => event.kind === 'executor-lease-acquired')).toHaveLength(1);
      expect(server.getExecutorStatus().active_executor_count).toBe(1);

      first.on('message', data => {
        const message = JSON.parse(data.toString()) as {
          kind?: string;
          requestId?: string;
          leaseId?: string;
          signature?: string;
        };
        if (message.kind !== 'betRequest' || !message.requestId) return;
        first.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId,
          receipt: {
            receiptId: 'r-lease',
            intentId: 'intent-lease-1',
            reservationId: 'rv-lease-1',
            status: 'ACCEPTED',
            amount: 10,
            market: 'bankerPair',
            mode: 'live',
            createdAt: '2026-09-04T00:00:01.000Z',
          },
          bridgeSessionId: 'bridge-session-first',
          bridgeSeq: 2,
        }));
      });

      await expect(server.requestBet(liveBetRequest())).resolves.toMatchObject({
        receiptId: 'r-lease',
      });
      expect(firstMessages.some(message => message.kind === 'betRequest')).toBe(true);
      expect(secondMessages.some(message => message.kind === 'betRequest')).toBe(false);
      const bet = firstMessages.find(message => message.kind === 'betRequest');
      expect(bet).toMatchObject({
        leaseId: expect.any(String),
        signature: expect.any(String),
      });
    } finally {
      first.close();
      second.close();
      await server.close();
    }
  });

  it('re-acquires the same lease after SW restart without creating a second executor', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const first = await openClient(port);
    try {
      sendHello(first, {
        sessionId: 'bridge-session-sw-1',
        seq: 1,
        profileId: 'chrome-profile-sw',
      });
      const acquired = await waitForEvent(events, 'executor-lease-acquired') as Extract<
        BrowserBridgeRuntimeEvent,
        { kind: 'executor-lease-acquired' }
      >;
      const leaseId = acquired.leaseId;
      expect(server.getExecutorStatus()).toEqual({
        active_executor_count: 1,
        leaseId,
        profileId: 'chrome-profile-sw',
        hostChannelId: undefined,
      });

      await new Promise<void>(resolve => {
        first.once('close', () => resolve());
        first.close();
      });
      // Allow close handler to park the lease.
      await new Promise(resolve => setTimeout(resolve, 20));
      const acquiredBeforeRestart = events.filter(event => event.kind === 'executor-lease-acquired').length;

      const restarted = await openClient(port);
      const restartedMessages: Array<Record<string, unknown>> = [];
      restarted.on('message', data => {
        restartedMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      sendHello(restarted, {
        sessionId: 'bridge-session-sw-2',
        seq: 1,
        profileId: 'chrome-profile-sw',
      });
      const started = Date.now();
      while (Date.now() - started < 500) {
        if (events.filter(event => event.kind === 'executor-lease-acquired').length > acquiredBeforeRestart) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const acquiredEvents = events.filter(
        (event): event is Extract<BrowserBridgeRuntimeEvent, { kind: 'executor-lease-acquired' }> =>
          event.kind === 'executor-lease-acquired',
      );
      expect(acquiredEvents.length).toBeGreaterThan(acquiredBeforeRestart);
      expect(new Set(acquiredEvents.map(event => event.leaseId)).size).toBe(1);
      expect(acquiredEvents.at(-1)).toMatchObject({
        leaseId,
        reacquired: true,
      });
      expect(server.getExecutorStatus().active_executor_count).toBe(1);
      expect(restartedMessages.some(message => message.kind === 'executorLeaseGranted')).toBe(true);
      restarted.close();
    } finally {
      await server.close();
    }
  });

  it('rejects a parallel Electron execution channel before any bet is sent', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 200,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const client = await openClient(port);
    let betRequestCount = 0;
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind?: string; requestId?: string };
      if (message.kind === 'betRequest') {
        betRequestCount += 1;
        client.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId,
          receipt: null,
          error: 'should-not-run-on-secondary-channel',
          bridgeSessionId: 'bridge-session-parallel',
          bridgeSeq: 2,
        }));
      }
    });
    try {
      sendHello(client, {
        sessionId: 'bridge-session-parallel',
        seq: 1,
        profileId: 'chrome-profile-parallel',
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(server.claimHostExecutionChannel('desktop-primary')).toEqual({
        ok: true,
        channelId: 'desktop-primary',
      });
      expect(server.claimHostExecutionChannel('desktop-secondary')).toMatchObject({
        ok: false,
        reason: 'parallel-execution-channel-rejected',
      });
      // Primary channel can still dispatch; secondary claim stays rejected.
      await expect(server.requestBet(liveBetRequest())).rejects.toThrow(/should-not-run-on-secondary-channel/);
      expect(betRequestCount).toBe(1);
      expect(server.claimHostExecutionChannel('desktop-other')).toMatchObject({
        ok: false,
        reason: 'parallel-execution-channel-rejected',
      });
      expect(server.getExecutorStatus().active_executor_count).toBe(1);
    } finally {
      client.close();
      await server.close();
    }
  });
});
