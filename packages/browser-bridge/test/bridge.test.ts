import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { BetExecutionRequest, OperationalWagerExecutionRequest } from '@baccarat/adapter-contract';
import type { BetReceipt } from '@baccarat/contracts';
import { replayEvents } from '../../ledger-state/src/projection.js';
import { cursorContinuityProof } from '@baccarat/room-monitor';
import {
  BUNDLED_BROWSER_EXTENSION_ID,
  BUNDLED_BROWSER_EXTENSION_TOKEN,
  BrowserBridgeServer,
  PRAGMATIC_BET_RUNTIME_REVISION,
  redactBridgeDiagnostic,
  type BrowserBridgeRuntimeEvent,
} from '../src/index.js';
import type { NormalizedEvent } from '@baccarat/contracts';

function bridgeEvent(tableId = 't1', eventId = 'e1'): NormalizedEvent {
  return {
    type: 'newShoeSignal',
    eventId,
    tableId,
    timestamp: '2025-01-01T00:00:00.000Z',
    sourceSeq: 1,
    shoeId: 's1',
    profile: {
      tableId,
      numberOfDecks: 8,
      pairRule: { kind: 'standard' },
      odds: {
        bankerPair: { netWin: 11, loss: 1 },
        playerPair: { netWin: 11, loss: 1 },
      },
      burnModel: { kind: 'unknown' },
      minEV: 0,
      limits: { minBet: 1, maxBet: 1000 },
      autoConfirmNewShoe: true,
      betStrategy: { type: 'both' },
    },
  };
}

function betRequest(mode: BetExecutionRequest['mode'] = 'simulated'): BetExecutionRequest {
  return {
    intent: {
      intentId: 'i1',
      tableId: 't1',
      shoeId: 's1',
      handId: 'h1',
      market: 'bankerPair',
      amount: 10,
      mode,
      idempotencyKey: 'k1',
      strategy: { type: 'both' },
      decisionSnapshotId: 'd1',
      createdAt: new Date().toISOString(),
    },
    mode,
    reservationId: 'rv1',
  };
}

function operationalWagerRequest(
  overrides: Partial<OperationalWagerExecutionRequest['wager']> = {},
): OperationalWagerExecutionRequest {
  return {
    mode: 'live',
    wager: {
      wagerId: 'operational-1',
      tableId: 'D055',
      shoeId: 'shoe-1',
      handId: 'GD055-1',
      market: 'banker',
      amount: 20,
      source: 'keepalive',
      createdAt: '2026-08-25T00:00:00.000Z',
      ...overrides,
    },
  };
}

type TestSocket = {
  send(data: string): void;
};

type TestObserverSocket = TestSocket & {
  readonly readyState: number;
};

function isTestSocketSet(value: unknown): value is Set<TestSocket> {
  return value instanceof Set;
}

function isTestObserverSocketSet(value: unknown): value is Set<TestObserverSocket> {
  return value instanceof Set;
}

function bridgeSockets(server: BrowserBridgeServer): Set<TestSocket> {
  const value: unknown = Reflect.get(server, 'sockets');
  if (!isTestSocketSet(value)) throw new Error('bridge socket set unavailable');
  return value;
}

function bridgeObservers(server: BrowserBridgeServer): Set<TestObserverSocket> {
  const value: unknown = Reflect.get(server, 'observers');
  if (!isTestObserverSocketSet(value)) throw new Error('bridge observer set unavailable');
  return value;
}

function bridgePendingBets(server: BrowserBridgeServer): Map<string, unknown> {
  const value: unknown = Reflect.get(server, 'pendingBets');
  if (!(value instanceof Map)) throw new Error('bridge pending bet map unavailable');
  return value;
}

function ingestFromSocket(server: BrowserBridgeServer, message: unknown, socket: TestSocket): void {
  const method: unknown = Reflect.get(server, 'ingestClientMessage');
  if (typeof method !== 'function') throw new Error('bridge message ingestion unavailable');
  Reflect.apply(method, server, [message, socket]);
}

const acceptedLiveReceipt: BetReceipt = {
  receiptId: 'r-sync',
  intentId: 'i1',
  reservationId: 'rv1',
  status: 'ACCEPTED',
  amount: 10,
  market: 'bankerPair',
  mode: 'live',
  createdAt: '2026-08-24T00:00:00.000Z',
};

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const VALID_CONTINUITY_PROOF = cursorContinuityProof({ test: 'bridge-restore' });

function extensionClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN });
}

function authenticatedExtensionClient(port: number): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
    { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
  );
}

function observerClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/observe`, { origin: 'http://localhost' });
}

function commandClient(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/command`, { origin: 'http://localhost' });
}

describe('browser bridge server', () => {
  it('discovers rooms from extension messages and merges default table profile', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'r1',
        displayName: 'Room 1',
        tables: [{ tableId: 't1', monitorUrl: 'win-1' }],
      },
    });

    const rooms = await server.discoverRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomId).toBe('r1');
    expect(rooms[0].tables[0].monitorUrl).toBe('win-1');
    expect(rooms[0].tables[0].profile.tableId).toBe('t1');
    expect(rooms[0].tables[0].profile.numberOfDecks).toBe(8);
  });

  it('exports live table events from the extension into ack-driven batches', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: Array<{ tableId: string; events: NormalizedEvent[] }> = [];

    await feed.start({
      onBatch: batch => { batches.push({ tableId: batch.tableId, events: batch.events }); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].events[0].eventId).toBe('e1');
    expect(feed.health().lastAckedSeq).toBe(1);
    expect(feed.health().bufferDepth).toBe(0);
  });

  it('ignores client-supplied restore proofs and restores only from the next continuous event', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();
    server.ingestClientMessage({ kind: 'tableDisconnected', roomId: 'r1', tableId: 't1', reason: 'page hidden' });
    server.ingestClientMessage({
      kind: 'tableRestored',
      roomId: 'r1',
      tableId: 't1',
      proof: VALID_CONTINUITY_PROOF,
    });

    expect(disconnects).toEqual(['page hidden']);
    expect(restores).toEqual([]);
    expect(feed.health().state).toBe('DISCONNECTED');

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: { ...bridgeEvent('t1', 'e2'), sourceSeq: 2 },
    });
    await feed.flush();

    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(restores[0]).not.toBe(VALID_CONTINUITY_PROOF);
    expect(feed.health().reconnectCount).toBe(1);
    expect(feed.health().state).toBe('CONNECTED');
  });

  it('fails closed on a table source sequence gap and recovers only from a physical-shoe reset', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const batches: NormalizedEvent[] = [];
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: batch => { batches.push(...batch.events); },
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: bridgeEvent(),
    });
    await feed.flush();

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: { ...bridgeEvent('t1', 'e3'), sourceSeq: 3 },
    });

    await expect(feed.flush()).rejects.toThrow(/continuity gap.*expected 2, got 3/i);
    expect(feed.health()).toMatchObject({
      state: 'DISCONNECTED',
      lastAckedSeq: 1,
    });
    expect(disconnects).toContainEqual(expect.stringMatching(/continuity gap.*expected 2, got 3/i));
    expect(batches.map(event => event.eventId)).toEqual(['e1']);

    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: {
        ...bridgeEvent('t1', 'e4'),
        sourceSeq: 4,
        baseline: 'physical-shoe',
      },
    });
    await feed.flush();

    expect(feed.health()).toMatchObject({
      state: 'CONNECTED',
      lastAckedSeq: 4,
    });
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(batches.map(event => event.eventId)).toEqual(['e1', 'e4']);
  });

  it('round-trips real bet execution requests through a WebSocket extension client', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const resultPromise = server.requestBet(betRequest());
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { kind: string; requestId?: string };
      if (message.kind === 'betRequest') {
        client.send(JSON.stringify({
          kind: 'betResult',
          requestId: message.requestId!,
          receipt: {
            receiptId: 'r1',
            intentId: 'i1',
            reservationId: 'rv1',
            status: 'SIMULATED',
            amount: 10,
            market: 'bankerPair',
            mode: 'simulated',
            createdAt: new Date().toISOString(),
          },
        }));
      }
    });

    const receipt = await resultPromise;
    expect(receipt).not.toBeNull();
    expect(receipt?.receiptId).toBe('r1');
    expect(receipt?.status).toBe('SIMULATED');

    client.close();
    await server.close();
  });

  it('round-trips a live operational wager through its matching receipt', async () => {
    // Given: exactly one extension client is connected to the local bridge.
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    // When: the desktop requests a banker keepalive wager.
    const resultPromise = server.requestOperationalWager(operationalWagerRequest());
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly requestId?: string };
      if (message.kind !== 'betRequest' || message.requestId === undefined) return;
      client.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: {
          receiptId: 'operational-receipt-1',
          wagerId: 'operational-1',
          tableId: 'D055',
          shoeId: 'shoe-1',
          handId: 'GD055-1',
          market: 'banker',
          amount: 20,
          source: 'keepalive',
          status: 'ACCEPTED',
          createdAt: '2026-08-25T00:00:01.000Z',
          raw: { runtimeRevision: PRAGMATIC_BET_RUNTIME_REVISION },
        },
      }));
    });

    // Then: the bridge preserves the operational receipt without coercing it into a pair-bet receipt.
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({
      receiptId: 'operational-receipt-1',
      wagerId: 'operational-1',
      market: 'banker',
      status: 'ACCEPTED',
    }));

    client.close();
    await server.close();
  });

  it('accepts a live operational wager from the same Pragmatic runtime family', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const request = operationalWagerRequest({
      tableId: 'tobcbaccaragen92',
      handId: '17260818724',
      source: 'manual',
    });
    const priorPragmaticRevision = PRAGMATIC_BET_RUNTIME_REVISION.replace(/\.\d+$/, '.9');
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly requestId?: string };
      if (message.kind !== 'betRequest' || message.requestId === undefined) return;
      client.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: {
          receiptId: 'pragmatic-operational-receipt-1',
          wagerId: request.wager.wagerId,
          tableId: request.wager.tableId,
          shoeId: request.wager.shoeId,
          handId: request.wager.handId,
          market: request.wager.market,
          amount: request.wager.amount,
          source: request.wager.source,
          status: 'ACCEPTED',
          createdAt: '2026-08-25T00:00:01.000Z',
          raw: { runtimeRevision: priorPragmaticRevision },
        },
      }));
    });

    try {
      await expect(server.requestOperationalWager(request)).resolves.toEqual(expect.objectContaining({
        receiptId: 'pragmatic-operational-receipt-1',
        tableId: 'tobcbaccaragen92',
        status: 'ACCEPTED',
        raw: expect.objectContaining({ runtimeRevision: priorPragmaticRevision }),
      }));
    } finally {
      client.close();
      await server.close();
    }
  });

  it('fails closed without restarting the browser when an operational receipt comes from an incompatible bet runtime', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    let reloadCommands = 0;
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string; readonly requestId?: string };
      if (message.kind === 'command' && message.name === 'reloadExtension') {
        reloadCommands += 1;
        return;
      }
      if (message.kind !== 'betRequest' || message.requestId === undefined) return;
      client.send(JSON.stringify({
        kind: 'betResult',
        requestId: message.requestId,
        receipt: {
          receiptId: 'obsolete-runtime-receipt',
          wagerId: 'operational-1',
          tableId: 'D055',
          shoeId: 'shoe-1',
          handId: 'GD055-1',
          market: 'banker',
          amount: 20,
          source: 'keepalive',
          status: 'REJECTED',
          createdAt: '2026-08-25T00:00:01.000Z',
          raw: { commitStarted: true, runtimeRevision: 'incompatible-runtime' },
        },
      }));
    });

    try {
      await expect(server.requestOperationalWager(operationalWagerRequest())).rejects.toMatchObject({
        message: expect.stringContaining('runtime revision mismatch'),
        receipt: expect.objectContaining({
          receiptId: 'obsolete-runtime-receipt',
          status: 'REJECTED',
          raw: expect.objectContaining({ commitStarted: true }),
        }),
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(reloadCommands).toBe(0);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('rejects a web-page origin before it becomes an extension socket', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const attacker = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://attacker.invalid' });
    try {
      // Given: a browser page outside the installed extension.
      const outcome = await new Promise<'opened' | 'rejected'>(resolve => {
        attacker.once('open', () => resolve('opened'));
        attacker.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve('rejected');
        });
        attacker.once('error', () => resolve('rejected'));
      });

      // When: it attempts to connect to the loopback bridge.
      expect(outcome).toBe('rejected');

      // Then: it cannot become the socket that controls extension commands.
    } finally {
      attacker.close();
      await server.close();
    }
  });

  it('accepts only the pinned bundled extension with the shared token', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const wrongId = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${BUNDLED_BROWSER_EXTENSION_TOKEN}`,
      { origin: EXTENSION_ORIGIN },
    );
    const missingToken = new WebSocket(
      `ws://127.0.0.1:${port}/`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    const bundled = authenticatedExtensionClient(port);
    try {
      const outcomes = await Promise.all([wrongId, missingToken, bundled].map(client =>
        new Promise<'opened' | 'rejected'>(resolve => {
          client.once('open', () => resolve('opened'));
          client.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve('rejected');
          });
          client.once('error', () => resolve('rejected'));
        })));
      expect(outcomes).toEqual(['rejected', 'rejected', 'opened']);
    } finally {
      wrongId.close();
      missingToken.close();
      bundled.close();
      await server.close();
    }
  });

  it('disconnects the extension and invalidates table continuity on a message sequence gap', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
    });
    const port = await server.start();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 3,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(feed.health().state).toBe('DISCONNECTED');
      expect(disconnects.some(reason => reason.startsWith('extension-message-gap:2:3'))).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });
  it('emits a table-disconnected runtime event when the export drain fails', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      onRuntimeEvent: event => events.push(event),
    });
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => { throw new Error('synthetic sink failure'); },
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
    });
    try {
      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: bridgeEvent(),
      });
      await expect(feed.flush()).rejects.toThrow('synthetic sink failure');
      expect(disconnects).toEqual(['synthetic sink failure']);
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'table-disconnected',
        tableId: 't1',
      }));
    } finally {
      await server.close();
    }
  });

  it('notifies the sink only once for repeated disconnects without an intervening restore', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
    });
    try {
      const exportInstance = feed as unknown as { handleDisconnect: (reason?: string) => void };
      exportInstance.handleDisconnect('first');
      exportInstance.handleDisconnect('second');
      expect(disconnects).toEqual(['first']);
    } finally {
      await server.close();
    }
  });


  it('does not drop tables when the same extension session reconnects within the disconnect grace', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      extensionDisconnectGraceMs: 80,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    let client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      client.close();
      await closed;
      await new Promise<void>(resolve => setImmediate(resolve));

      client = extensionClient(port);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 2,
      }));
      await new Promise<void>(resolve => setTimeout(resolve, 120));

      expect(disconnects).toEqual([]);
      expect(feed.health().state).toBe('CONNECTED');
      expect(events.some(event => event.kind === 'extension-disconnected')).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('disconnects tables after the extension-socket grace expires without reconnect', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      extensionDisconnectGraceMs: 40,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      client.close();
      await closed;
      await new Promise<void>(resolve => setTimeout(resolve, 80));

      expect(disconnects).toEqual(['browser-extension-disconnected']);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'extension-disconnected' }));
    } finally {
      client.close();
      await server.close();
    }
  });

  it('invalidates continuity when a new extension session connects during disconnect grace', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      extensionDisconnectGraceMs: 80,
    });
    const port = await server.start();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    let client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-one',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      client.close();
      await closed;
      await new Promise<void>(resolve => setImmediate(resolve));

      client = extensionClient(port);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });
      client.send(JSON.stringify({
        kind: 'heartbeat',
        timestamp: new Date().toISOString(),
        bridgeSessionId: 'bridge-session-two',
        bridgeSeq: 1,
      }));
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setTimeout(resolve, 30));

      expect(disconnects).toEqual(['extension-session-restarted']);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('holds a shuffled table connected through the post-shuffle quiet window', async () => {
    const server = new BrowserBridgeServer({ tableStaleAfterMs: 1_000 });
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const ingestEvent = Reflect.get(feed, 'ingestEvent');
    if (typeof ingestEvent !== 'function') throw new Error('ingestEvent unavailable');
    ingestEvent.call(feed, bridgeEvent('t1', 'shuffle-1'));
    const checkFreshness = Reflect.get(feed, 'checkFreshness');
    if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
    Reflect.apply(checkFreshness, feed, [Date.now() + 2 * 60 * 1000]);
    expect(feed.health().state).toBe('CONNECTED');
    expect(disconnects).toEqual([]);
    Reflect.apply(checkFreshness, feed, [Date.now() + 11 * 60 * 1000]);
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(disconnects).toEqual(['table-feed-stale']);
    await server.close();
  });

  it('marks a connected table stale and reports real observation age', async () => {
    const server = new BrowserBridgeServer({ tableStaleAfterMs: 1_000 });
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => disconnects.push(reason ?? ''),
    });
    const checkFreshness = Reflect.get(feed, 'checkFreshness');
    if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
    Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);

    expect(feed.health().state).toBe('DISCONNECTED');
    expect(disconnects).toEqual(['table-feed-stale']);
    await expect(feed.keepAlive()).resolves.toMatchObject({
      ok: false,
      latencyMs: expect.any(Number),
    });

    const noteObservation = Reflect.get(feed, 'noteObservation');
    if (typeof noteObservation !== 'function') throw new Error('observation hook unavailable');
    Reflect.apply(noteObservation, feed, []);
    await new Promise(resolve => setImmediate(resolve));
    expect(feed.health().state).toBe('CONNECTED');
  });

  it('does not request a whole-page reload after feed progress remains stale', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      tableStaleAfterMs: 1_000,
    });
    const port = await server.start();
    const extension = extensionClient(port);
    const feed = server.openTable('r1', 't1');
    await feed.start({ onBatch: () => {} });
    const commands: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        extension.once('open', resolve);
        extension.once('error', reject);
      });
      extension.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string };
        if (message.kind === 'command' && message.name !== undefined) commands.push(message.name);
      });
      const checkFreshness = Reflect.get(feed, 'checkFreshness');
      if (typeof checkFreshness !== 'function') throw new Error('freshness watchdog unavailable');
      Reflect.apply(checkFreshness, feed, [Date.now() + 2_000]);
      await new Promise<void>(resolve => setTimeout(resolve, 30));

      expect(commands).not.toContain('reloadGameTabs');
    } finally {
      extension.close();
      await server.close();
    }
  });

  it('keeps observer clients read-only while allowing local command clients', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const extension = extensionClient(port);
    const observer = observerClient(port);
    const command = commandClient(port);
    try {
      await Promise.all([extension, observer, command].map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));

      // Given: an extension, a read-only observer, and a local command client.
      const commands: Array<{ readonly name: string; readonly tableIds?: readonly string[] }> = [];
      const receivedCommand = new Promise<void>(resolve => {
        extension.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly name?: string;
            readonly tableIds?: readonly string[];
          };
          if (message.kind !== 'command' || message.name === undefined) return;
          commands.push({
            name: message.name,
            ...(message.tableIds === undefined ? {} : { tableIds: message.tableIds }),
          });
          if (message.name === 'replayRuntimeState') resolve();
        });
      });

      // When: both the observer and the command client send a bridge command.
      observer.send(JSON.stringify({ kind: 'command', name: 'liveOn' }));
      command.send(JSON.stringify({
        kind: 'command',
        name: 'replayRuntimeState',
        tableIds: ['D066', 'D067'],
      }));
      await receivedCommand;
      await new Promise<void>(resolve => setImmediate(resolve));

      // Then: only the dedicated command client reaches the extension.
      expect(commands).toEqual([{
        name: 'replayRuntimeState',
        tableIds: ['D066', 'D067'],
      }]);
    } finally {
      extension.close();
      observer.close();
      command.close();
      await server.close();
    }
  });

  it('fails closed for live bets when no extension socket is connected', async () => {
    const server = new BrowserBridgeServer({ betTimeoutMs: 5 });

    await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/exactly one browser extension connection/i);
  });

  it('fails closed for live bets with multiple extension sockets without sending a bet request', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 5 });
    const port = await server.start();
    const clients = [
      extensionClient(port),
      extensionClient(port),
    ];
    const betRequestCount = { value: 0 };
    try {
      await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));
      for (const client of clients) {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { readonly kind?: string };
          if (message.kind === 'betRequest') betRequestCount.value += 1;
        });
      }

      await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/exactly one browser extension connection/i);
      expect(betRequestCount.value).toBe(0);
    } finally {
      for (const client of clients) client.close();
      await server.close();
    }
  });

  it('registers the pending live bet before a synchronous socket result can arrive', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 5 });
    const port = await server.start();
    const client = extensionClient(port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      const socket = [...bridgeSockets(server)][0];
      if (socket === undefined) throw new Error('extension socket missing');
      socket.send = data => {
        const message = JSON.parse(data) as { readonly kind?: string; readonly requestId?: string };
        if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
        ingestFromSocket(server, {
          kind: 'betResult',
          requestId: message.requestId,
          receipt: acceptedLiveReceipt,
        }, socket);
      };

      await expect(server.requestBet(betRequest('live'))).resolves.toEqual(acceptedLiveReceipt);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('rejects a dispatched live bet immediately when its extension socket closes and clears pending state', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 1_000 });
    const port = await server.start();
    const client = extensionClient(port);
    let requestId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });

      const dispatched = new Promise<void>((resolve, reject) => {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly requestId?: string;
          };
          if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
          requestId = message.requestId;
          resolve();
          client.close();
        });
        client.once('error', reject);
      });
      const resultPromise = server.requestBet(betRequest('live'));

      await dispatched;
      const outcome = await Promise.race([
        resultPromise.then(
          () => 'resolved',
          error => error instanceof Error ? error.message : String(error),
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('deadline'), 100)),
      ]);

      expect(outcome).toMatch(/disconnected/i);
      if (requestId === undefined) throw new Error('live bet request id missing');
      expect(bridgePendingBets(server).has(requestId)).toBe(false);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('serializes pair and keepalive requests for the same table', async () => {
    const server = new BrowserBridgeServer({ betTimeoutMs: 1_000 });
    const requestIds: string[] = [];
    const socket: TestSocket = {
      send(data: string): void {
        const message: unknown = JSON.parse(data);
        if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
        if (Reflect.get(message, 'kind') !== 'betRequest') return;
        const requestId = Reflect.get(message, 'requestId');
        if (typeof requestId === 'string') requestIds.push(requestId);
      },
    };
    bridgeSockets(server).add(socket);
    const pairRequest: BetExecutionRequest = {
      ...betRequest('live'),
      intent: {
        ...betRequest('live').intent,
        tableId: 'D055',
      },
    };
    const keepaliveRequest = operationalWagerRequest();
    const keepaliveReceipt = {
      receiptId: 'keepalive-receipt',
      wagerId: keepaliveRequest.wager.wagerId,
      tableId: keepaliveRequest.wager.tableId,
      shoeId: keepaliveRequest.wager.shoeId,
      handId: keepaliveRequest.wager.handId,
      market: keepaliveRequest.wager.market,
      amount: keepaliveRequest.wager.amount,
      source: keepaliveRequest.wager.source,
      status: 'ACCEPTED' as const,
      createdAt: '2026-08-25T00:00:00.000Z',
      raw: { runtimeRevision: PRAGMATIC_BET_RUNTIME_REVISION },
    };

    try {
      const pair = server.requestBet(pairRequest);
      const keepalive = server.requestOperationalWager(keepaliveRequest);

      await Promise.resolve();
      expect(requestIds).toHaveLength(1);
      const pairRequestId = requestIds[0];
      if (pairRequestId === undefined) throw new Error('pair request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: pairRequestId,
        receipt: acceptedLiveReceipt,
      }, socket);
      await expect(pair).resolves.toEqual(acceptedLiveReceipt);

      await Promise.resolve();
      expect(requestIds).toHaveLength(2);
      const keepaliveRequestId = requestIds[1];
      if (keepaliveRequestId === undefined) throw new Error('keepalive request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: keepaliveRequestId,
        receipt: keepaliveReceipt,
      }, socket);
      await expect(keepalive).resolves.toEqual(keepaliveReceipt);
    } finally {
      bridgeSockets(server).delete(socket);
      await server.close();
    }
  });

  it('serializes different Pragmatic tables through the shared multitable UI', async () => {
    const server = new BrowserBridgeServer({ betTimeoutMs: 1_000 });
    const requestIds: string[] = [];
    const socket: TestSocket = {
      send(data: string): void {
        const message: unknown = JSON.parse(data);
        if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
        if (Reflect.get(message, 'kind') !== 'betRequest') return;
        const requestId = Reflect.get(message, 'requestId');
        if (typeof requestId === 'string') requestIds.push(requestId);
      },
    };
    bridgeSockets(server).add(socket);
    const firstRequest: BetExecutionRequest = {
      ...betRequest('live'),
      intent: { ...betRequest('live').intent, intentId: 'pragmatic-1', tableId: 'speedbca14gesbc1' },
    };
    const secondRequest: BetExecutionRequest = {
      ...betRequest('live'),
      intent: { ...betRequest('live').intent, intentId: 'pragmatic-2', tableId: 'tobcbaccaragen92' },
    };

    try {
      const first = server.requestBet(firstRequest);
      const second = server.requestBet(secondRequest);

      await Promise.resolve();
      expect(requestIds).toHaveLength(1);
      const firstRequestId = requestIds[0];
      if (firstRequestId === undefined) throw new Error('first Pragmatic request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: firstRequestId,
        receipt: { ...acceptedLiveReceipt, intentId: 'pragmatic-1' },
      }, socket);
      await expect(first).resolves.toEqual(expect.objectContaining({ intentId: 'pragmatic-1' }));

      await Promise.resolve();
      expect(requestIds).toHaveLength(2);
      const secondRequestId = requestIds[1];
      if (secondRequestId === undefined) throw new Error('second Pragmatic request id missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId: secondRequestId,
        receipt: { ...acceptedLiveReceipt, intentId: 'pragmatic-2' },
      }, socket);
      await expect(second).resolves.toEqual(expect.objectContaining({ intentId: 'pragmatic-2' }));
    } finally {
      bridgeSockets(server).delete(socket);
      await server.close();
    }
  });

  it('ignores a live bet result received on a different extension socket', async () => {
    const server = new BrowserBridgeServer({ port: 0, betTimeoutMs: 1_000 });
    const port = await server.start();
    const originalClient = extensionClient(port);
    let newClient: WebSocket | undefined;
    let requestId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        originalClient.once('open', resolve);
        originalClient.once('error', reject);
      });
      const dispatched = new Promise<void>((resolve, reject) => {
        originalClient.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            readonly kind?: string;
            readonly requestId?: string;
          };
          if (message.kind !== 'betRequest' || typeof message.requestId !== 'string') return;
          requestId = message.requestId;
          resolve();
        });
        originalClient.once('error', reject);
      });
      const resultPromise = server.requestBet(betRequest('live'));
      await dispatched;
      if (requestId === undefined) throw new Error('live bet request id missing');

      const replacementClient = extensionClient(port);
      newClient = replacementClient;
      await new Promise<void>((resolve, reject) => {
        replacementClient.once('open', resolve);
        replacementClient.once('error', reject);
      });
      const serverSockets = [...bridgeSockets(server)];
      const replacementServerSocket = serverSockets[1];
      if (replacementServerSocket === undefined) throw new Error('replacement extension socket missing');
      ingestFromSocket(server, {
        kind: 'betResult',
        requestId,
        receipt: acceptedLiveReceipt,
      }, replacementServerSocket);

      expect(bridgePendingBets(server).has(requestId)).toBe(true);
      originalClient.send(JSON.stringify({
        kind: 'betResult',
        requestId,
        receipt: acceptedLiveReceipt,
      }));
      await expect(resultPromise).resolves.toEqual(acceptedLiveReceipt);
    } finally {
      originalClient.close();
      newClient?.close();
      await server.close();
    }
  });

  it('arms live execution only through a connected extension command channel', async () => {
    // Given: live execution must fail closed when no extension is connected.
    const server = new BrowserBridgeServer({ port: 0 });
    expect(() => server.setLiveBetEnabled(true)).toThrow(/exactly one browser extension connection/i);
    const port = await server.start();
    const client = extensionClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const command = new Promise<{ readonly kind: string; readonly name?: string }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind: string; readonly name?: string };
        if (message.kind === 'command') resolve(message);
      });
    });

    // When: the desktop explicitly enables real execution.
    server.setLiveBetEnabled(true);

    // Then: exactly the extension command channel receives the live-on instruction.
    await expect(command).resolves.toEqual({ kind: 'command', name: 'liveOn' });
    client.close();
    await server.close();
  });

  it('fails closed for live arming with multiple sockets while still broadcasting liveOff', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const clients = [
      extensionClient(port),
      extensionClient(port),
    ];
    const liveOnCount = { value: 0 };
    const liveOffCount = { value: 0 };
    let resolveLiveOff: (() => void) | undefined;
    const liveOffReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for liveOff broadcast')), 100);
      resolveLiveOff = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    try {
      await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      })));
      for (const client of clients) {
        client.on('message', data => {
          const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string };
          if (message.kind !== 'command') return;
          if (message.name === 'liveOn') liveOnCount.value += 1;
          if (message.name === 'liveOff') {
            liveOffCount.value += 1;
            if (liveOffCount.value === clients.length) resolveLiveOff?.();
          }
        });
      }

      expect(() => server.setLiveBetEnabled(true)).toThrow(/exactly one browser extension connection/i);
      server.setLiveBetEnabled(false);
      await liveOffReceived;

      expect(liveOnCount.value).toBe(0);
      expect(liveOffCount.value).toBe(2);
    } finally {
      for (const client of clients) client.close();
      await server.close();
    }
  });

  it('keeps exports disconnected when the page only claims session recovery', async () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');
    const disconnects: string[] = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: () => {},
      onDisconnect: (_tableId, reason) => { disconnects.push(reason ?? ''); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });
    expect(feed.health().state).toBe('CONNECTED');

    server.ingestClientMessage({
      kind: 'sessionExpired',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      textPreview: '会话已过期',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(disconnects).toEqual(['game-session-expired']);

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovered',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:01:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(restores).toEqual([]);
    expect(feed.health().reconnectCount).toBe(0);
  });

  it('restores an expired export only from a physical-shoe reset', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: Array<{ tableId: string; events: NormalizedEvent[] }> = [];
    const restores: string[] = [];

    await feed.start({
      onBatch: batch => { batches.push({ tableId: batch.tableId, events: batch.events }); },
      onRestored: (_tableId, proof) => { restores.push(proof); },
    });

    server.ingestClientMessage({
      kind: 'sessionExpired',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      textPreview: '会话已过期',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');

    const physicalReset = {
      ...bridgeEvent(),
      baseline: 'physical-shoe' as const,
    };
    server.ingestClientMessage({
      kind: 'tableEvent',
      roomId: 'r1',
      tableId: 't1',
      event: physicalReset,
    });
    await feed.flush();

    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatch(/^cursor-v1:[a-f0-9]{64}$/);
    expect(feed.health().state).toBe('CONNECTED');
    expect(batches).toHaveLength(1);
    expect(batches[0].events[0].eventId).toBe('e1');
  });

  it('waits for asynchronous restoration before draining the first recovered event', async () => {
    const server = new BrowserBridgeServer();
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: { roomId: 'r1', tables: [{ tableId: 't1' }] },
    });
    const feed = server.openTable('r1', 't1');
    const batches: NormalizedEvent[] = [];
    let releaseRestoration: () => void = () => undefined;
    const restorationBlocked = new Promise<void>(resolve => {
      releaseRestoration = resolve;
    });

    try {
      await feed.start({
        onBatch: batch => { batches.push(...batch.events); },
        onRestored: async () => await restorationBlocked,
      });
      server.ingestClientMessage({
        kind: 'sessionExpired',
        url: 'https://www.dafabet.net/room',
        frame: 'top',
        textPreview: '会话已过期',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      server.ingestClientMessage({
        kind: 'tableEvent',
        roomId: 'r1',
        tableId: 't1',
        event: {
          ...bridgeEvent(),
          baseline: 'physical-shoe',
        },
      });
      await Promise.resolve();

      expect(batches).toEqual([]);

      releaseRestoration();
      await feed.flush();
      expect(batches).toEqual([{
        ...bridgeEvent(),
        baseline: 'physical-shoe',
      }]);
    } finally {
      releaseRestoration();
      await server.close();
    }
  });

  it('ignores keepalive and session actions that do not affect exports', () => {
    const server = new BrowserBridgeServer();
    const feed = server.openTable('r1', 't1');

    server.ingestClientMessage({
      kind: 'keepalive',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:00:00.000Z',
      target: { x: 10, y: 20, width: 30, height: 30 },
    });
    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'reload-scheduled',
      attempt: 1,
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    expect(feed.health().state).toBe('DISCONNECTED');
    expect(feed.health().reconnectCount).toBe(0);
  });

  it('broadcasts observable session events to connected observer clients', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = observerClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const observed = new Promise<{ kind: string; message: { kind: string } }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind: string; message?: { kind: string } };
        if (message.kind === 'observe' && message.message) {
          resolve({ kind: message.kind, message: message.message });
        }
      });
    });

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'keepalive-click',
      url: 'https://www.dafabet.net/room',
      frame: 'top',
      detail: 'record button',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const seen = await observed;
    expect(seen.message.kind).toBe('sessionAction');

    client.close();
    await server.close();
  });

  it('broadcasts redacted game-channel network captures to observers only', async () => {
    const server = new BrowserBridgeServer({ port: 0 });
    const port = await server.start();
    const client = observerClient(port);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const observed = new Promise<{ kind: string; message: { kind: string; url: string; data: string } }>(resolve => {
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { kind: string; message?: { kind: string; url: string; data: string } };
        if (message.kind === 'observe' && message.message?.kind === 'networkCapture') {
          resolve({ kind: message.kind, message: message.message });
        }
      });
    });

    const longData = 'x'.repeat(8000);
    // 非游戏域名(视频流)不应广播。
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://cdn.video.example.test/websocketstream2',
      direction: 'recv',
      encoding: 'base64',
      data: longData,
    });
    // 游戏通道应广播且截断。
    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-ws',
      url: 'wss://gs24.pragmaticplaylive.net/game/t1/socket',
      direction: 'send',
      encoding: 'text',
      data: longData,
    });

    const seen = await observed;
    expect(seen.message.kind).toBe('networkCapture');
    expect(seen.message.url).toContain('pragmaticplaylive');
    expect(seen.message.data).toBe('[redacted 8000 bytes]');

    client.close();
    await server.close();
  });

  it('does not request openMultiView when the page falls back to a single table', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      selectedTableIds: ['tableaaaaaa01', 'tableaaaaaa02'],
    });
    const port = await server.start();
    const extension = extensionClient(port);
    const commands: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        extension.once('open', resolve);
        extension.once('error', reject);
      });
      extension.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind?: string; readonly name?: string };
        if (message.kind === 'command' && message.name) commands.push(message.name);
      });
      server.ingestClientMessage({
        kind: 'networkCapture',
        source: 'baccarat-bridge-runtime-selection',
        url: 'https://client.pragmaticplaylive.net/desktop/baccarat/',
        direction: 'recv',
        encoding: 'text',
        data: JSON.stringify({ tableIds: ['tableaaaaaa01'] }),
      });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(commands).not.toContain('openMultiView');
    } finally {
      extension.close();
      await server.close();
    }
  });

  it('filters unselected tables from discovered and updated rooms', async () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055', 'D056'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'r1',
        tables: [{ tableId: 'D055' }, { tableId: 'P001' }, { tableId: 'D099' }],
      },
    });

    let rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId)).toEqual(['D055']);

    server.ingestClientMessage({
      kind: 'roomUpdated',
      room: {
        roomId: 'r1',
        tables: [{ tableId: 'D056' }, { tableId: 'P001' }],
      },
    });

    rooms = await server.discoverRooms();
    expect(rooms.find(room => room.roomId === 'r1')?.tables.map(table => table.tableId)).toEqual(['D056']);
  });



  it('keeps unselected discovered tables available for the monitor picker', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });
    server.ingestClientMessage({
      kind: 'roomDiscovered',
      room: {
        roomId: 'picker-room',
        displayName: 'Picker Room',
        tables: [{ tableId: 'D055' }, { tableId: 'P001' }],
      },
    });

    expect(server.getDiscoveredRooms().find(room => room.roomId === 'picker-room')?.tables.map(table => table.tableId))
      .toEqual(['D055', 'P001']);
    expect(server.getRooms().find(room => room.roomId === 'picker-room')?.tables.map(table => table.tableId))
      .toEqual(['D055']);
  });



  it('rejects openTable for an unselected table', () => {
    const server = new BrowserBridgeServer({ selectedTableIds: ['D055'] });

    expect(() => server.openTable('r1', 'P001')).toThrow(/not selected/);
    expect(() => server.openTable('r1', 'D055')).not.toThrow();
  });
});


describe('dynamic configured live-table selection', () => {

  it('reveals runtime lifecycle metadata to observers without exposing card bytes or URL parameters', () => {
    const server = new BrowserBridgeServer();
    const messages: string[] = [];
    bridgeObservers(server).add({
      readyState: WebSocket.OPEN,
      send: data => { messages.push(data); },
    });

    server.ingestClientMessage({
      kind: 'networkCapture',
      source: 'baccarat-bridge-pragmatic-ws',
      url: 'wss://gs24.pragmaticplaylive.net/game?session=secret',
      direction: 'recv',
      encoding: 'text',
      data: JSON.stringify({
        tableId: 'bc281koreanch281',
        roundId: '1726012345',
        gmstatus: 4,
        playerCardCount: 2,
        bankerCardCount: 3,
        capturedAt: '2026-08-25T15:04:00.000Z',
      }),
    });

    expect(messages).toHaveLength(1);
    const observed: unknown = JSON.parse(messages[0] ?? '');
    expect(observed).toMatchObject({
      kind: 'observe',
      message: {
        kind: 'networkCapture',
        source: 'baccarat-bridge-pragmatic-ws',
        url: 'wss://gs24.pragmaticplaylive.net/game',
      },
    });
    expect(messages[0]).not.toContain('secret');
    expect(messages[0]).not.toContain('playerCards');
    expect(messages[0]).not.toContain('bankerCards');
  });
});

describe('browser bridge runtime supervision', () => {
  it('blocks live arming and dispatch until the extension sequence is authenticated', async () => {
    const server = new BrowserBridgeServer({
      port: 0,
      betTimeoutMs: 5,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
    });
    const port = await server.start();
    const client = authenticatedExtensionClient(port);
    let betRequestCount = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      client.on('message', data => {
        const message = JSON.parse(data.toString()) as { readonly kind?: string };
        if (message.kind === 'betRequest') betRequestCount += 1;
      });

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: false,
      });
      expect(() => server.setLiveBetEnabled(true)).toThrow(/authenticated extension sequence/i);
      await expect(server.requestBet(betRequest('live'))).rejects.toThrow(/authenticated extension sequence/i);
      expect(betRequestCount).toBe(0);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('reports rejected extension identity and requires a sequenced authenticated session', async () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      port: 0,
      requireExtensionSequence: true,
      allowedExtensionId: BUNDLED_BROWSER_EXTENSION_ID,
      extensionToken: BUNDLED_BROWSER_EXTENSION_TOKEN,
      onRuntimeEvent: event => events.push(event),
    });
    const port = await server.start();
    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/`,
      { origin: `chrome-extension://${BUNDLED_BROWSER_EXTENSION_ID}` },
    );
    const client = authenticatedExtensionClient(port);
    try {
      await Promise.all([
        new Promise<void>(resolve => {
          rejected.once('unexpected-response', (_request, response) => {
            response.resume();
            resolve();
          });
          rejected.once('error', () => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          client.once('open', resolve);
          client.once('error', reject);
        }),
      ]);

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: false,
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'extension-auth-failed' }));

      client.send(JSON.stringify({
        kind: 'hello',
        extensionVersion: '0.1.0',
        browser: 'Chrome',
        timestamp: '2026-08-27T01:00:00.000Z',
        bridgeSessionId: 'bridge-session-20260827',
        bridgeSeq: 1,
      }));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (events.some(event => event.kind === 'extension-authenticated')) break;
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      expect(server.getExtensionStatus()).toMatchObject({
        connectionCount: 1,
        authenticated: true,
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'extension-authenticated' }));
    } finally {
      rejected.close();
      client.close();
      await server.close();
    }
  });

  it('emits recovery exhaustion and recovery completion without claiming table continuity', () => {
    const events: BrowserBridgeRuntimeEvent[] = [];
    const server = new BrowserBridgeServer({
      onRuntimeEvent: event => events.push(event),
    });

    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovery-failed',
      url: 'https://www.dafabet.net/room?token=secret',
      frame: 'iframe',
      detail: 'still expired after 3 reload attempts',
      timestamp: '2026-08-27T01:00:00.000Z',
    });
    server.ingestClientMessage({
      kind: 'sessionAction',
      action: 'recovered',
      url: 'https://www.dafabet.net/room?token=secret',
      frame: 'iframe',
      timestamp: '2026-08-27T01:01:00.000Z',
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session-recovery-exhausted' }),
      expect.objectContaining({ kind: 'session-recovered' }),
    ]));
  });

  it('redacts diagnostic URLs and never retains title, body, or HTML previews', () => {
    expect(redactBridgeDiagnostic({
      kind: 'diagnostic',
      url: 'https://www.dafabet.net/room?token=secret&account=alice',
      frame: 'iframe',
      readyState: 'complete',
      title: 'private title',
      bodyTextPreview: 'private body',
      htmlPreview: '<div>private html</div>',
      candidateCount: 1,
      canvasCount: 2,
      videoCount: 3,
      iframeCount: 4,
    })).toEqual({
      kind: 'diagnostic',
      url: 'https://www.dafabet.net/room',
      frame: 'iframe',
      readyState: 'complete',
      titleLength: 13,
      bodyTextLength: 12,
      htmlLength: 23,
      candidateCount: 1,
      canvasCount: 2,
      videoCount: 3,
      iframeCount: 4,
    });
  });
});

